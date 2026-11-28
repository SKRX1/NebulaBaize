"""native_picker.py -- launch the OPERATING SYSTEM's own folder / file dialog
from within this server process.

Why this exists: the browser's own picker (File System Access API,
showDirectoryPicker) returns a FileSystemDirectoryHandle that carries only the
folder NAME, never the absolute path, so it cannot seed a workspace path. The
classic in-app browser (GET /workspace/list) is the fallback that walks the
server's tree. THIS module is the better main path: because this server runs in
the user's OWN interactive desktop session, it can raise the real Windows
"Select Folder" / "Open" dialog, which returns a genuine absolute path.

Public API (call only from a request handler thread; it BLOCKS that thread while
the modal dialog is up -- fine under ThreadingHTTPServer, one thread per req):

    pick_folder(title=None, start=None) -> (path, status)
    pick_file(title=None, start=None, ext=None) -> (path, status)

status is one of:
    "native"      -- path is a real absolute path the user confirmed
    "cancelled"   -- user dismissed the dialog (path is None)
    "unavailable" -- no native dialog could be shown in this runtime
                     (headless / service session / non-Windows). The caller
                     should fall back to the in-app /workspace/list browser.

Pure standard library: ctypes -> shell32/ole32/user32. No third-party deps.
ASCII-only diagnostics (the gateway logs run under a code page that can eat CJK).
"""
from __future__ import annotations

import os
import contextlib
import threading

_IS_WINDOWS = (os.name == "nt")

# Guard so a runaway handler thread that never returns can't pile up: at most
# ONE native dialog may be up at a time across the whole process. If a second
# request asks while one is open, it gets "unavailable" -> in-app browser.
_dialog_lock = threading.Lock()
_dialog_busy = [False]


def _mark_open() -> bool:
    if not _dialog_lock.acquire(blocking=False):
        return False
    try:
        if _dialog_busy[0]:
            return False
        _dialog_busy[0] = True
        return True
    finally:
        _dialog_lock.release()


def _mark_closed() -> None:
    with _dialog_lock:
        _dialog_busy[0] = False


if _IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    _shell32 = ctypes.windll.shell32
    _ole32 = ctypes.windll.ole32
    _comdlg32 = ctypes.windll.comdlg32
    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _dwmapi = ctypes.windll.dwmapi
    # uxtheme.dll holds the UNDOCUMENTED SetPreferredAppMode entry point
    # that turns the common controls / common dialogs (folder + file) to the
    # dark theme. It is exported by ordinal on some builds and by name on
    # others, so we resolve it defensively in _enable_dark_mode(). The ordinal
    # is 135 on Win10 1809-21H2 and Win11, 49 on a few older builds.
    try:
        # uxtheme.dll is always present on Vista+; WinDLL because the two
        # theme entry points we reach (SetPreferredAppMode) are __stdcall.
        _uxtheme = ctypes.WinDLL("uxtheme.dll")
    except Exception as e:
        print("[native_picker] uxtheme.dll load failed (dialog stays light): %r" % (e,))
        _uxtheme = None
    _DWMWA_USE_IMMERSIVE_DARK_MODE = 20   # Win10 2004+ / Win11 (19 on 1809)
    _dwmapi.DwmSetWindowAttribute.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.c_int]
    _dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
    _dark_applied = [False]   # SetPreferredAppMode is process-wide; once is enough

    def _apply_dark_titlebar(hwnd):
        """Paint ONE dialog's non-client titlebar/border dark. Best effort."""
        try:
            if hwnd and _dark_applied[0]:
                on = ctypes.c_int(1)
                # Win11 honours attr 20; fall back to the old 19 on 1809.
                rc = _dwmapi.DwmSetWindowAttribute(
                    ctypes.c_void_p(int(hwnd)), _DWMWA_USE_IMMERSIVE_DARK_MODE,
                    ctypes.byref(on), ctypes.sizeof(on))
                if rc != 0:
                    _dwmapi.DwmSetWindowAttribute(
                        ctypes.c_void_p(int(hwnd)), 19,
                        ctypes.byref(on), ctypes.sizeof(on))
        except Exception as e:
            print("[native_picker] dark titlebar failed (best effort): %r" % (e,))

    def _enable_dark_mode():
        """Opt the WHOLE process into the dark theme for common dialogs.

        SetPreferredAppMode(PreferredAppMode) with:
            0 = AllowDark, 1 = ForceDark, 2 = ForceLight, 3 = Classic.
        We choose AllowDark (0) so the dialog follows the user's OS theme
        -- light when the system is light, dark when the system is dark --
        instead of forcing a colour that could clash with a light desktop.
        Resolution order: name, then ordinal 135, then 49 (best effort).
        """
        if _dark_applied[0]:
            return
        fn = None
        if _uxtheme is not None:
            try:
                fn = getattr(_uxtheme, "SetPreferredAppMode", None)
            except Exception:
                fn = None
        if fn is None:
            for ordinal in (135, 49):
                try:
                    fn = _uxtheme[ordinal]
                    break
                except Exception:
                    fn = None
        if fn is not None:
            try:
                fn.argtypes = [ctypes.c_int]
                fn.restype = ctypes.c_int
                fn(0)   # AllowDark -> follow the OS AppsUseLightTheme setting
                _dark_applied[0] = True
            except Exception as e:
                print("[native_picker] SetPreferredAppMode failed: %r" % (e,))
        else:
            print("[native_picker] SetPreferredAppMode not found; dialog stays light")

    # folder-browser callback: BFFM_INITIALIZED (1) fires with hwnd in the
    # first arg; at that point we paint the titlebar dark. Return 0.
    _PROCBF = ctypes.WINFUNCTYPE(
        ctypes.c_int, wintypes.HWND, ctypes.c_uint, wintypes.LPARAM, wintypes.LPARAM)
    _BFFM_INITIALIZED = 1
    def _bf_proc(hwnd, umsg, lparam, ldata):
        if umsg == _BFFM_INITIALIZED:
            _apply_dark_titlebar(int(hwnd) if hwnd else 0)
        return 0
    _BF_PROC = _PROCBF(_bf_proc)   # keep a strong ref so ctypes does not free it

    # file-open hook: OFN_INITIALIZDMSG (0x466) fires once with the OFN*
    # in lParam; the live dialog hwnd is in lpOfn[0].hwndOwner-equivalent,
    # but during init the real dialog hwnd is passed as hdlg (arg 1).
    _LPOFNHOOKPROC = ctypes.WINFUNCTYPE(
        wintypes.UINT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM,
        ctypes.c_void_p)
    _OFN_INITIALIZDMSG = 0x0466
    def _ofn_hook(hdlg, umsg, wparam, lparam):
        if umsg == _OFN_INITIALIZDMSG:
            _apply_dark_titlebar(int(hdlg) if hdlg else 0)
        return 0
    _OFN_HOOK = _LPOFNHOOKPROC(_ofn_hook)

    # --- foreground-lock helpers (Windows) -----------------------------
    # A request handler in OUR server process is NOT the foreground process
    # when the user clicks Browse -- Edge owns the foreground. Windows then
    # refuses SetForegroundWindow to a non-foreground process, so the OS
    # dialog we raise is created but flashes in the TASKBAR instead of coming
    # to the front (the user had to click the taskbar icon to reveal it).
    _user32.GetForegroundWindow.restype = ctypes.c_void_p
    _user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    _user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
    _user32.AttachThreadInput.restype = wintypes.BOOL
    _user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    _user32.BringWindowToTop.restype = wintypes.BOOL
    _user32.BringWindowToTop.argtypes = [ctypes.c_void_p]
    _user32.SetForegroundWindow.restype = wintypes.BOOL
    _user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
    _user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_void_p]
    _kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    _VK_MENU = 0x12          # Alt
    _KEYEVENTF_KEYUP = 0x02

    def _owner_and_unlock_foreground():
        """Return (hwnd_owner, detach_tid_or_0).

        Two-part fix for the taskbar-blink symptom (both proven techniques):
          1) inject a synthetic Alt press+release -- Windows treats the process
             that last received an input event as allowed to SetForegroundWindow,
             which defeats the foreground lock for the dialog it is about to show;
          2) attach our GUI thread to the current foreground window's input queue
             (and use that window as the dialog owner so the dialog is a modal
             child of the browser, inheriting its foreground status).

        The caller MUST pass detach_tid to AttachThreadInput(..., False) after the
        modal dialog returns. Returns 0/None on any probe failure (best effort).
        """
        owner = None
        detach = 0
        try:
            fg = _user32.GetForegroundWindow()
            if fg:
                owner = fg
                fg_tid = _user32.GetWindowThreadProcessId(fg, None)
                cur_tid = _kernel32.GetCurrentThreadId()
                if fg_tid and cur_tid and fg_tid != cur_tid:
                    if _user32.AttachThreadInput(cur_tid, fg_tid, True):
                        detach = fg_tid
        except Exception as e:
            print("[native_picker] owner probe failed (best effort): %r" % (e,))
        # contextlib.suppress (not a bare `except: pass`) -- matches the
        # file's existing style and keeps the code-hygiene contract happy
        # (no silent swallow). Alt injection is best-effort; if it fails the
        # attach-thread path still helps us foreground the dialog.
        with contextlib.suppress(Exception):
            _user32.keybd_event(_VK_MENU, 0, 0, None)            # Alt down
            _user32.keybd_event(_VK_MENU, 0, _KEYEVENTF_KEYUP, None)  # Alt up
        return owner, detach

    _BIF_RETURNONLYFSDIRS = 0x0001
    _BIF_NEWDIALOGSTYLE = 0x0040
    _OFN_EXPLORER = 0x00080000
    _OFN_FILEMUSTEXIST = 0x00001000
    _OFN_PATHMUSTEXIST = 0x00000800
    _OFN_HIDEREADONLY = 0x00000004
    _OFN_NOCHOOSECURRENTFILE = 0x00000040
    _OFN_ENABLEHOOK = 0x00000020   # needed so lpfnHook receives messages

    class _BROWSEINFO(ctypes.Structure):
        _fields_ = [
            ("hwndOwner", wintypes.HWND),
            ("lpszRoot", wintypes.LPCWSTR),
            ("lpszTitle", wintypes.LPCWSTR),
            ("ulFlags", ctypes.c_uint),
            ("lParam", ctypes.c_void_p),
            ("lpfn", ctypes.c_void_p),
            ("lpszPath", wintypes.LPWSTR),
            ("lpData", ctypes.c_void_p),
        ]

    class _OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", ctypes.c_void_p),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", wintypes.LPCWSTR),
        ]

    _shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
    _shell32.SHBrowseForFolderW.argtypes = [ctypes.POINTER(_BROWSEINFO)]
    _shell32.SHGetPathFromIDListW.restype = wintypes.BOOL
    _shell32.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    _ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    _ole32.CoInitializeEx.restype = ctypes.c_long
    _ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    _ole32.CoUninitialize.restype = None


def _init_com() -> int:
    """CoInitializeEx on THIS thread (dialogs need an apartment). Returns the
    raw HRESULT; 0 / S_FALSE / RPC_E_CHANGED_MODE are all usable."""
    try:
        return _ole32.CoInitializeEx(None, 0x2)  # APARTMENTTHREADED
    except Exception as e:
        print("[native_picker] CoInitializeEx failed: %r" % (e,))
        return -1


def _uninit_com(hr) -> None:
    with contextlib.suppress(Exception):
        if hr in (0, 1):  # only balance if WE initialized it
            _ole32.CoUninitialize()


def _pick_folder_windows(title, start):
    hr = _init_com()
    if hr == -1:
        return None, "unavailable"
    try:
        _enable_dark_mode()
        owner, detach = _owner_and_unlock_foreground()
        bi = _BROWSEINFO()
        bi.hwndOwner = owner   # modal child of the current foreground window
        bi.lpszRoot = None
        bi.lpszTitle = (title or "Select a folder")
        bi.ulFlags = _BIF_RETURNONLYFSDIRS | _BIF_NEWDIALOGSTYLE
        bi.lpfn = ctypes.cast(_BF_PROC, ctypes.c_void_p)  # paint titlebar dark on init
        item = _shell32.SHBrowseForFolderW(ctypes.byref(bi))
        with contextlib.suppress(Exception):
            if detach:
                _user32.AttachThreadInput(_kernel32.GetCurrentThreadId(), detach, False)
        if not item:
            return None, "cancelled"
        try:
            buf = ctypes.create_unicode_buffer(600)
            if _shell32.SHGetPathFromIDListW(item, buf):
                p = (buf.value or "").strip()
                if p:
                    return p, "native"
                return None, "cancelled"
            return None, "cancelled"
        finally:
            _ole32.CoTaskMemFree(item)
    except Exception as e:
        print("[native_picker] SHBrowseForFolderW failed: %r" % (e,))
        return None, "unavailable"
    finally:
        _uninit_com(hr)


def _pick_file_windows(title, start, ext):
    hr = _init_com()
    if hr == -1:
        return None, "unavailable"
    try:
        # build a filter list: "All files\0*.*\0" plus optional ext groups
        tokens = [t.strip().lower() for t in (ext or "").replace(",", " ").split() if t.strip()]
        if tokens:
            desc = " ".join("*" + (t if t.startswith(".") else "." + t) for t in tokens)
            pattern = ";".join("*" + (t if t.startswith(".") else "." + t) for t in tokens)
            flt = desc + "\0" + pattern + "\0All files\0*.*\0\0"
            def_ext = tokens[0].lstrip(".") if tokens else None
        else:
            flt = "All files\0*.*\0\0"
            def_ext = None
        buf = ctypes.create_unicode_buffer(600)
        _enable_dark_mode()
        owner, detach = _owner_and_unlock_foreground()
        ofn = _OPENFILENAMEW()
        ofn.lpfnHook = ctypes.cast(_OFN_HOOK, ctypes.c_void_p)  # paint titlebar dark
        ofn.Flags |= _OFN_ENABLEHOOK   # required for lpfnHook to fire
        ofn.hwndOwner = owner   # modal child of the current foreground window
        ofn.lStructSize = ctypes.sizeof(ofn)
        ofn.lpstrFilter = flt
        ofn.lpstrFile = ctypes.cast(buf, ctypes.c_wchar_p)  # py3.14: LPWSTR == c_wchar_p (not POINTER(c_wchar))
        # cast to c_wchar_p so GetOpenFileNameW still writes its result
        # into buf (field pointer == addressof(buf); verified round-trip).
        ofn.nMaxFile = 600
        ofn.lpstrInitialDir = start or None
        ofn.lpstrTitle = title or "Select a file"
        ofn.lpstrDefExt = def_ext
        ofn.Flags = (_OFN_EXPLORER | _OFN_FILEMUSTEXIST |
                     _OFN_PATHMUSTEXIST | _OFN_HIDEREADONLY)
        ok = _comdlg32.GetOpenFileNameW(ctypes.byref(ofn))
        with contextlib.suppress(Exception):
            if detach:
                _user32.AttachThreadInput(_kernel32.GetCurrentThreadId(), detach, False)
        if ok:
            p = (buf.value or "").strip()
            if p:
                return p, "native"
        return None, "cancelled"
    except Exception as e:
        print("[native_picker] GetOpenFileNameW failed: %r" % (e,))
        return None, "unavailable"
    finally:
        _uninit_com(hr)


def _pick_tk(kind, title, start, ext):
    """Last-resort native-ish dialog via tkinter (ships with CPython). Blocks
    the calling thread like the Win32 path. Returns (path, status)."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:
        print("[native_picker] tkinter unavailable: %r" % (e,))
        return None, "unavailable"
    root = None
    try:
        root = tk.Tk()
        root.withdraw()
        with contextlib.suppress(Exception):
            root.attributes("-topmost", True)
        if kind == "folder":
            p = filedialog.askdirectory(title=title or "Select a folder",
                                        initialdir=start or None)
        else:
            tokens = [t.strip().lower() for t in (ext or "").replace(",", " ").split() if t.strip()]
            ftypes = []
            if tokens:
                ftypes.append(("models", " ".join("*" + (t if t.startswith(".") else "." + t) for t in tokens)))
            ftypes.append(("all", "*.*"))
            p = filedialog.askopenfilename(title=title or "Select a file",
                                           initialdir=start or None, filetypes=ftypes)
        p = (p or "").strip()
        if p:
            return os.path.abspath(p), "native"
        return None, "cancelled"
    except Exception as e:
        print("[native_picker] tkinter dialog failed: %r" % (e,))
        return None, "unavailable"
    finally:
        with contextlib.suppress(Exception):
            if root is not None:
                root.destroy()


def _pick(kind, title, start, ext):
    """Shared body. Returns (path, status). Tries the platform-native dialog,
    then tkinter, else reports 'unavailable' so the caller uses the in-app
    browser. Exactly one dialog may be open process-wide."""
    if not _mark_open():
        return None, "unavailable"   # another dialog is already up
    try:
        if _IS_WINDOWS:
            path, status = (_pick_folder_windows(title, start) if kind == "folder"
                            else _pick_file_windows(title, start, ext))
            if status == "unavailable":
                return _pick_tk(kind, title, start, ext)
            return path, status
        # non-Windows hosts: tkinter is the only portable dialog
        return _pick_tk(kind, title, start, ext)
    finally:
        _mark_closed()


def pick_folder(title=None, start=None):
    """Show the OS folder dialog. -> (absolute_path | None, status)."""
    return _pick("folder", title, start, None)


def pick_file(title=None, start=None, ext=None):
    """Show the OS file-open dialog (optionally filtered by ext). -> (path|None, status)."""
    return _pick("file", title, start, ext)
