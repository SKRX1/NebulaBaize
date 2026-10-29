/* differential pure-logic replica of recycle pagination (zero DOM):
   mirrors paintRecycleBin/paintRecycleAudit slice + recycleMore +30 + more-button gate.
   Positive: 100 items -> first 30 rows, more label "70"; after 1 click -> 60.
   Negative: 20 items -> all 20 shown, NO more button (shown>=total).
   Audit: newest-first (reverse) then slice(0,limit). */
const RECYCLE_LIST_LIMIT = 30;
function binPaint(data, limit){ return data.slice(0, limit); }
function auditPaint(data, limit){ return data.slice().reverse().slice(0, limit); }
function moreShown(shown, total){ return shown < total; }
function moreAfter(limit){ return limit + 30; }

let fail = 0;
const ck = (label, cond) => { console.log((cond?"OK  ":"FAIL")+"  "+label); if(!cond) fail++; };

const big = Array.from({length:100}, (_,i)=>"p"+i);
const small = Array.from({length:20}, (_,i)=>"p"+i);

// bin default -> 30 rows, more shown (70 remaining)
let b1 = binPaint(big, RECYCLE_LIST_LIMIT);
ck("bin default = 30 rows", b1.length === 30);
ck("bin more-button shown (100>30)", moreShown(b1.length, big.length) === true);
ck("bin more label counts 70", (big.length - b1.length) === 70);
// after one more -> limit 60
ck("bin after-more = 60 rows", binPaint(big, moreAfter(RECYCLE_LIST_LIMIT)).length === 60);

// audit newest-first then slice
let a1 = auditPaint(big, RECYCLE_LIST_LIMIT);
ck("audit default = 30 rows", a1.length === 30);
ck("audit is newest-first (starts at p99)", a1[0] === "p99");

// negative: small data -> all shown, NO more button
ck("small bin = 20 rows (all)", binPaint(small, RECYCLE_LIST_LIMIT).length === 20);
ck("small bin NO more-button", moreShown(20, small.length) === false);
ck("small audit NO more-button", moreShown(auditPaint(small, RECYCLE_LIST_LIMIT).length, small.length) === false);

process.exit(fail ? 1 : 0);
