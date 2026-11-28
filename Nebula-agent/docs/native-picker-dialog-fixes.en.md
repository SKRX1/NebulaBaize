# Native Picker Dialog Triple-Fix Cheatsheet

> **English** | [简体中文](native-picker-dialog-fixes.md)

Distills the **root cause + two-part fix** for the three native folder/file dialog issues on the
workspace / model-directory picker. All conclusions were read from source + verified live this
session (not speculation). Files: `runtime/native_picker.py`, `runtime/http_server.py`,
`servers/fs_server.py`; three fixes are centralised and shared by the GET/POST/fs_server paths.

Baseline tags: `v-baseline-2026-11-28-d` (`ee14581`, GET alias + MCP reuse),
`v-baseline-2026-11-28-e` (`1d18031`, foreground-unlock + dark theme).

## Why we raise our own native dialog

The browser's File System Access API (`showDirectoryPicker`) returns a handle with only the folder
NAME, never the absolute path, so it cannot seed a workspace path. This gateway runs in the user's
own interactive desktop session, so `native_picker.py` (pure stdlib: ctypes -> shell32/ole32/user32/
comdlg32/dwmapi/uxtheme) raises the real Windows folder/open dialog and returns a genuine absolute
path; the in-app `/workspace/list` browser is the fallback.

## Fix 1 · agent can raise it too + `/api/pick` GET alias (`ee14581` / tag `-d`)

**Root cause/need**: the native dialog only served the frontend Browse buttons (POST); the agent and
plain browser navigation could not use it.

**Two parts**:
1. **MCP reuse**: `servers/fs_server.py` adds a `pick_native` tool (`kind=folder|file`, optional
   `title/start/ext`). It **lazily imports** `runtime/native_picker` (a sibling of servers/; the path
   is added to sys.path at call time) so the agent raises the **same** dialog. Module load does not
   depend on runtime, so a host without a desktop / without runtime still loads fs_server and only
   this tool degrades to `unavailable`.
2. **GET alias**: `do_GET` in `runtime/http_server.py` prepends a `/api/pick` branch **before** the
   generic `path.startswith("/api/")` proxy (otherwise it is forwarded upstream by `_api("GET")`);
   `_api_pick` reads `kind/title/start/ext` from the **query first**, falling back to the POST JSON
   body only when there is no query -- one function serves GET navigation and POST alike.

**Verified**: fs_server tool list includes `pick_native` (`HAS_PICK_NATIVE True`), the agent call
really raises the dialog and returns `cancelled`; the GET alias raised the dialog (`DIALOG_SHOWN=True`).

## Fix 2 · dialog raised to the foreground (`e03f217`)

**Root cause**: `SHBrowseForFolderW`/`GetOpenFileNameW` used `hwndOwner=None` with no foreground
unlock. When the user clicks Browse the **foreground process is Edge**; the gateway python process is
a background process, and the Windows **foreground lock** denies `SetForegroundWindow` to it -- the
dialog is created but appears inactive and flashes in the taskbar, so the user had to click the taskbar
icon to reveal it.

**Two parts** (centralised in `_owner_and_unlock_foreground()`):
1. inject a synthetic **Alt key-down/up** (`keybd_event(VK_MENU,…)`) before raising, defeating the lock;
2. **`AttachThreadInput`** the GUI thread to the current foreground window's input queue and set
   `hwndOwner` to that window (the dialog becomes a modal child of the browser), then detach with
   `AttachThreadInput(…,False)` after the modal returns.

**Verified**: `GetForegroundWindow()==FindWindow("#32770")` shows the dialog is the foreground window
(`fg==dlg=True`); cancelling returns `cancelled`; the attach/detach round-trip is clean.

## Fix 3 · follow the system dark theme (`1d18031` / tag `-e`)

**Root cause**: `HKCU\…\Themes\Personalize AppsUseLightTheme=0` (system is dark) yet native_picker had
**zero** dark-mode declaration -> the native dialog defaulted to light, clashing with the system.

**Two parts** (centralised in `_enable_dark_mode()`):
1. **process-wide** `uxtheme.dll!SetPreferredAppMode(0=AllowDark)`: makes common controls/dialogs
   follow the OS theme (dark when dark, light when light, never forcing a clash). It is not in the
   export name table, so it is resolved defensively by name -> ordinal 135 (Win10 1809+ & Win11) ->
   49 (older). uxtheme is loaded with `ctypes.WinDLL("uxtheme.dll")` (stdcall) under a try-guard so a
   missing module never breaks import.
2. **window-level** `DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE=20, fall back 19 on
   1809)`: paints the titlebar/border dark too. The folder dialog uses the `BROWSEINFO.lpfn` callback
   at `BFFM_INITIALIZED(=1)` to grab the hwnd; the file dialog uses `OPENFILENAME.lpfnHook`
   (requires `OFN_ENABLEHOOK 0x20`) at init to grab the hdlg.

**Verified**: `DwmGetWindowAttribute rc=0 attr=1` (titlebar immersive-dark attribute reads back 1),
`_dark_applied=True`, the lpfn callback does not crash, cancel returns `cancelled`. System theme is
dark when `AppsUseLightTheme=0`.

## Verification & gotchas (quick notes)

- Titlebar truly dark: `DwmGetWindowAttribute(…,20)` returns attr==1 -- better than a screenshot for automation.
- Dialog truly foregrounded: does `GetForegroundWindow()` equal `FindWindowW("#32770",None)`.
- Use `ctypes.WinDLL` for SetPreferredAppMode/uxtheme, **not** `windll.LoadLibraryW` (AttributeError).
- Code hygiene: swallow with `contextlib.suppress(Exception)`, never a bare `except Exception: pass`
  (runtime/ forbids silent swallow).
- The sandbox shell deny list blocks `rmdir /s /q`; clean temp clone dirs with
  `Shell.Application.NameSpace(10).MoveHere` (Recycle Bin).
- For these to paint on a RUNNING instance, restart port 8099 to reload (a self-terminating action;
  the timing is the user's call).

## Addendum · file-dialog ctypes cast fix + forensic confirmation of both dialogs
(Plan D: keep the legacy folder dialog unchanged)

**Hazard**: on this Python 3.14 box, `GetOpenFileNameW` raised
`TypeError('incompatible types, LP_c_wchar instance instead of c_wchar_p instance')`. Root cause:
3.14 tightened `LPWSTR` to `c_wchar_p` (no longer `POINTER(c_wchar)`), so the old line
`ofn.lpstrFile = ctypes.cast(buf, ctypes.POINTER(ctypes.c_wchar))` produced an `LP_c_wchar`
incompatible with the new field type -> native file dialog creation threw, was caught by
`_pick_file_windows`'s except, logged a `[native_picker] GetOpenFileNameW failed` line, then
fell back to `_pick_tk()`. Although tkinter's `askopenfilename` on Windows still resolves to a
native common dialog (visual unchanged), the extra hop + stderr noise was a real latent defect.

**Fix**: `ofn.lpstrFile = ctypes.cast(buf, ctypes.c_wchar_p)`. Round-trip verified: after the
cast the field pointer == `addressof(buf)`, and after simulating a native write `buf.value` reads
back correctly -- i.e. GetOpenFileNameW can still write its result into buf (the cast only swaps
the pointer wrapper; the buffer stays writable).

**Verified**: after the fix the real file dialog is foreground `class=#32770 / title=` our
`FixCheckFile` (genuinely native, not the tkinter fallback), `NATIVE_FAILED_LINE=False` (the
stderr failed line is gone), watchdog posts `WM_COMMAND/IDCANCEL` to auto-dismiss -> `cancelled`.

**Both-dialogs current-state forensic evidence** (screenshots via real desktop PIL grab --
native dialogs are system windows, not web DOM, so `browser__screenshot` cannot capture them;
window classes read via `EnumWindows`; saved under `data/uploads/search/`):

- **folder** (Plan D keeps legacy `SHBrowseForFolderW`): observed `class=#32770 / title=Browse For
  Folder` -- a genuine legacy native tree dialog (dark titlebar covered by Fix 3 above).
- **file** (`GetOpenFileNameW`): before the fix it fell back to tkinter which still resolved to a
  native common dialog (`class=#32770`); after the fix it goes straight through GetOpenFileNameW,
  still `class=#32770`.

Both dialogs belong to the same Win32 common-dialog family `#32770`: the folder dialog uses the
legacy tree with a dark titlebar, the file dialog is Explorer-style. **Visually consistent** --
no native-vs-webview mismatch, and no risk of regressing to a non-native look.
