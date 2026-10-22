#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""Permanent asset (task 1/3/5) — registered in run_tests.py SUITES, same level as tests/.
CI runs it automatically on ANY change (run_suite runs this .py, exit 0 == green).

Segment-level-scroll + running-badge + manual-override gate, FIVE quadrants:

  A1 stepsFold OFF  : only the LIVE segment th2 opens; th0/th1 folded; no group
  A2 stepsFold ON   : only the LIVE segment th2 opens; th0/th1 folded, packed into the OPEN group
  B1 running        : the originator's row shows the live badge (LIT)
  B2 finished       : no row shows a badge (OUT)
  C1 manual-override: REAL render (visible in the screenshot, verdict reads off the real DOM).
                      mC is the LATEST message in the FINISHED state -> thinkOpen auto-expands
                      EVERY segment. Write a MANUAL fold on one segment (thinkOpen[slot]=false)
                      and it must render FOLDED, while a segment with NO manual value stays OPEN.
                      The fold is proven to come from the manual value ALONE (a global rule would
                      fold both) -> the chain top "a manual toggle wins" (app.js:2273) is pinned.

It rebuilds the fixture from the LIVE index.html (full DOM skeleton so app.js's top-level
boot does not crash), appends the driver, renders in headless Edge, reads the <title>
(ASCII-normalised verdicts) and the screenshot. Result appended to outputs\seg_scroll_baseline.jsonl.
Hard asserts = the CI red/green line: all five quadrants must pass. ASCII-only prints.

Run: python tools/_seg_scroll_baseline.py               (rebuild + render + assert)
     python tools/_seg_scroll_baseline.py --assert-only  (reuse the existing fixture)

Companion pixel evidence (ASCII path, headless Edge refuses Chinese dirs):
     msedge --headless=new --screenshot=C:\Users\sk\seg_scroll_verify.png <fixture>
First run 2026-10-21 four quadrants; manual-override quadrant added 2026-10-22; registered in
run_tests.py SUITES 2026-10-22 (CI runs it on any change).
"""
import os, sys, json, subprocess, time

HERE = r"E:\WorkBuddy\星云智能体\strata-agent\tools"
ROOT = os.path.dirname(HERE)
WEBDIR = os.path.join(ROOT, "serve", "web")
FIXTURE_HTML = os.path.join(ROOT, "serve", "seg_scroll_verify.html")
OUT = os.path.join(ROOT, "outputs", "seg_scroll_baseline.jsonl")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

DRIVER = """
<script>
(function(){
  function buildMsg(){
    return { role:"assistant", time:Date.now(),
      reasoning:"Slice zero of the thought. Slice one of the thought. Slice two of the thought.",
      text:"", tools:[ {at:0,rat:24,server:"x",tool:"call1",state:"ok"},
                       {at:0,rat:49,server:"x",tool:"call2",state:"ok"} ] };
  }
  function segLine(el,tag){
    var segs=[].slice.call(el.querySelectorAll(".st-think")).map(function(d){return d.dataset.slot+(d.open?"=OPEN":"=folded");});
    var grp=el.querySelector('[data-slot="steps"]');
    var gtxt=grp?("GROUP-open="+grp.open):"nogroup";
    return tag+"|"+segs.join(",")+"|"+gtxt;
  }
  var chat=document.getElementById("chat");
  settings.show=true; settings.stepsFold=false;
  var mA=buildMsg(); messages=[mA];
  var elA=msgEl(mA,0); chat.appendChild(elA); updateAssistant(elA,mA,true);
  var lineA=segLine(elA,"OFF");
  settings.show=true; settings.stepsFold=true;
  var mB=buildMsg(); messages=[mA,mB];
  var elB=msgEl(mB,1); chat.appendChild(elB); updateAssistant(elB,mB,true);
  var lineB=segLine(elB,"ON");
  var seed=[{id:"a",title:"A task",workspace:"",permission:"auto",messages:[{role:"user",text:"ask A1",images:[],files:[],time:Date.now()}],updatedAt:Date.now()}];
  sessions=seed; activeId="a"; messages=seed[0].messages;
  busy={sessionId:"a", msg:null}; renderSessions();
  var realClsB1 = document.querySelector('.st-session[data-sid="a"]').className;
  var lineB1="RUNNING|badge="+((realClsB1+" ").indexOf(" running ")>=0||realClsB1.indexOf("running ")>=0||/running/.test(realClsB1)?"LIT":"OUT");
  busy=null; renderSessions();
  var lineB2="FINISHED|badge="+(/running/.test(document.querySelector('.st-session[data-sid="a"]').className)?"LIT":"OUT");

  // ---- Q5: manual-override, REAL render so the manual fold is visible in the screenshot ----
  // mC is the LATEST message in the FINISHED state -> thinkOpen auto-expands EVERY segment.
  // Write a MANUAL fold on the live slot (thinkOpen[th2]=false); it must render FOLDED while the
  // control slot with NO manual value stays OPEN. The fold is proven to be the manual value's doing.
  settings.show=true; settings.stepsFold=false;
  var mC=buildMsg();
  mC.thinkOpen={"th2":false};                       // user manually folded this segment
  messages=[mA,mB,mC];                              // mC is the latest (index 2)
  var elC=msgEl(mC,2); chat.appendChild(elC); updateAssistant(elC,mC,false);   // FINISHED state
  var mapC={};
  [].slice.call(elC.querySelectorAll(".st-think")).forEach(function(d){mapC[d.dataset.slot]=!!d.open;});
  var liveFolded = (mapC["th2"]===false);            // manual fold beat the all-open auto rule
  var noManualOpens = (mapC["th1"]===true);          // control: auto-open -> the fold is the manual value's doing
  var lineC="MANUAL|"+"liveFolded="+(liveFolded?"YES":"NO")+"|noManualOpens="+(noManualOpens?"YES":"NO");
  var box=document.createElement("pre");
  box.style.cssText="font:700 20px monospace;background:#111;color:#0f0;padding:16px;margin:16px;border:3px solid #0f0;white-space:pre-wrap";
  box.textContent="SEGMENT SCROLL\\n  A stepsFold-OFF: "+lineA+"\\n  B stepsFold-ON : "+lineB+
    "\\n\\nRUNNING BADGE\\n  B1 running  : "+lineB1+"\\n  B2 finished : "+lineB2+
    "\\n\\nMANUAL OVERRIDE (rendered above: the manual slice FOLDED, the control slice OPEN)\\n  C "+lineC;
  document.body.appendChild(box);
  document.title="SEG"+lineA.replace(/[^A-Za-z0-9|=]/g,"")+"_"+lineB.replace(/[^A-Za-z0-9|=]/g,"")+
    "_BA"+lineB1.replace(/[^A-Za-z0-9|=]/g,"")+"_BB"+lineB2.replace(/[^A-Za-z0-9|=]/g,"")+
    "_CC"+lineC.replace(/[^A-Za-z0-9|=]/g,"");
})();
</script>
"""

EXPECT = {
    "state_off": {"open": ["th2=OPEN"], "folded": ["th0=folded", "th1=folded"], "group": "nogroup"},
    "state_on":  {"open": ["th2=OPEN"], "folded": ["th0=folded", "th1=folded"], "group": "groupopen"},
    "badge_run": ["badge=LIT"],
    "badge_fin": ["badge=OUT"],
    "q5_manual": {"live": "livefolded=yes", "ctrl": "nomanualopens=yes"},
}

def rebuild():
    html = open(os.path.join(WEBDIR, "index.html"), encoding="utf-8").read()
    idx = html.rfind("</body>")
    assert idx > 0, "no body end"
    open(FIXTURE_HTML, "w", encoding="utf-8").write(html[:idx] + DRIVER + html[idx:])
    print("FIXTURE-REBUILT", FIXTURE_HTML.encode("ascii", "replace").decode("ascii"))

def read_title():
    out = subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--dump-dom",
                          "file:///" + FIXTURE_HTML.replace("\\", "/")],
                         capture_output=True, text=True, timeout=60,
                         stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace")
    dom = out.stdout or ""
    lo, hi = dom.find("<title"), dom.find("</title>")
    if lo < 0 or hi < 0:
        return ""
    t = dom[lo:hi]
    gt = t.find(">")
    return t[gt+1:] if gt >= 0 else t

def main():
    import re
    if "--assert-only" not in sys.argv[1:]:
        rebuild()
    title = read_title()
    print("TITLE", title.encode("ascii", "replace").decode("ascii"))
    if not title.startswith("SEG"):
        print("TITLE-NOT-SET (Edge did not run the driver) -> FAIL")
        sys.exit(2)

    m_off = re.search(r"SEG(OFF.*?)_(?=ON)", title)
    m_on  = re.search(r"_(ON.*?)_(?=BA)", title)
    m_run = re.search(r"BA(RUNNING.*?)_(?=BB)", title)
    m_fin = re.search(r"BB(FINISHED.*?)_(?=CC)", title)
    m_q5  = re.search(r"CC(MANUAL.*?)$", title)

    low_off = (m_off.group(1) if m_off else "").lower()
    low_on  = (m_on.group(1) if m_on else "").lower()
    low_run = (m_run.group(1) if m_run else "").lower()
    low_fin = (m_fin.group(1) if m_fin else "").lower()
    low_q5  = (m_q5.group(1) if m_q5 else "").lower()

    v_off = (all(w.lower() in low_off for w in EXPECT["state_off"]["open"])
             and all(w.lower() in low_off for w in EXPECT["state_off"]["folded"])
             and EXPECT["state_off"]["group"] in low_off)
    v_on = (all(w.lower() in low_on for w in EXPECT["state_on"]["open"])
            and all(w.lower() in low_on for w in EXPECT["state_on"]["folded"])
            and EXPECT["state_on"]["group"] in low_on)
    v_run = all(w.lower() in low_run for w in EXPECT["badge_run"])
    v_fin = all(w.lower() in low_fin for w in EXPECT["badge_fin"])
    v_q5  = EXPECT["q5_manual"]["live"] in low_q5 and EXPECT["q5_manual"]["ctrl"] in low_q5

    for name, v in (("OFF", v_off), ("ON", v_on), ("BADGE-RUN", v_run), ("BADGE-FIN", v_fin), ("Q5-MANUAL", v_q5)):
        print("QUAD", name, "PASS" if v else "FAIL")

    record = {"ts": int(time.time()), "title": title,
              "state_off": v_off, "state_on": v_on, "badge_run": v_run,
              "badge_fin": v_fin, "q5_manual": v_q5}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print("BASELINE-APPENDED", OUT.encode("ascii", "replace").decode("ascii"))
    if not (v_off and v_on and v_run and v_fin and v_q5):
        print("SEG-SCROLL-BASELINE: FAIL")
        sys.exit(1)
    print("SEG-SCROLL-BASELINE: ALL PASS (5 quadrants)")

if __name__ == "__main__":
    main()
