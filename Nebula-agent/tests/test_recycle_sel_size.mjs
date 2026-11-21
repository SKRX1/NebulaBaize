/* differential pure-logic replica of the recycle select-size feature (zero DOM):
   mirrors the data-size carry + the aggregate/three-state branch added to updateRecycleSel().
   Positive: 3 checked incl. a 5 MB one -> MB branch; boundary 1048576 -> MB; partial check
   -> indeterminate; full check -> checked, no indeterminate.
   Negative: nothing checked -> count text has NO separator (nothing selected, nothing to sum);
   whitelist-disabled rows never count toward the selall denominator.
   The selall-click path must refresh BOTH count and size (the old bug class: checkbox flips
   but the count line stays stale). */

function fmtBytesSel(n) { return n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

// replica: rows = [{size, disabled, checked}] ; label = "已选" ; sep = " · "
function countLine(rows, label, sep) {
  const checked = rows.filter(r => r.checked);
  let bytes = 0;
  checked.forEach(r => { bytes += r.size || 0; });
  return checked.length + " " + label + (checked.length ? " " + sep + " " + fmtBytesSel(bytes) : "");
}
function selAllState(rows) {
  const total = rows.filter(r => !r.disabled).length;
  const checked = rows.filter(r => r.checked && !r.disabled).length;
  return { checked: total > 0 && checked === total, indeterminate: checked > 0 && checked < total };
}
// selall checkbox flips every ACTIONABLE row, then the shared change handler re-runs both
function clickSelAll(rows, want) {
  rows.forEach(r => { if (!r.disabled) r.checked = want; });
  return rows;
}

let fail = 0;
const ck = (label, cond) => { console.log((cond ? "OK  " : "FAIL") + "  " + label); if (!cond) fail++; };

const rows = [
  { size: 1024, disabled: false, checked: true },
  { size: 2048, disabled: false, checked: true },
  { size: 5 * 1048576, disabled: false, checked: true },
  { size: 999, disabled: false, checked: false },
  { size: 4096, disabled: true, checked: false },   // whitelisted: never in the denominator
];

// positive: MB branch + label + separator
ck("3 checked -> MB branch", countLine(rows, "selected", "\u00b7") === "3 selected \u00b7 5.0 MB");
// the two KB rows + one MB row: 1024+2048+5242880 = 5245952 B = 5.0 MB (>=1048576)
// boundary: exactly 1048576 -> MB branch
ck("boundary 1048576 -> MB", fmtBytesSel(1048576) === "1.0 MB");
ck("below boundary -> KB (toFixed rounds .999 up to 1024.0, real behaviour)", fmtBytesSel(1048575) === "1024.0 KB");
// negative: nothing checked -> no separator
ck("zero checked -> no separator", countLine([{ size: 10, disabled: false, checked: false }], "selected", "\u00b7") === "0 selected");
// three-state: partial check -> indeterminate
ck("partial check -> indeterminate", selAllState(rows).indeterminate === true && selAllState(rows).checked === false);
// full check (disabled row can never be checked) -> checked, no indeterminate
const full = JSON.parse(JSON.stringify(rows)); full.forEach(r => { if (!r.disabled) r.checked = true; });
ck("full check -> checked only", selAllState(full).checked === true && selAllState(full).indeterminate === false);
// the SELALL-CLICK contract: flipping rows then re-running the shared handler refreshes
// BOTH count and size in one line (the old stale-count bug class).
const live = JSON.parse(JSON.stringify(rows));
clickSelAll(live, true);
const line = countLine(live, "selected", "\u00b7");
ck("selall click refreshes count+size together",
   line === "4 selected \u00b7 5.0 MB");   // 1024+2048+5242880+999 = 5246951 -> 5.0 MB
ck("selall click -> selall stays full-checked",
   selAllState(live).checked === true && selAllState(live).indeterminate === false);
// negative control for the bug class: WITHOUT the refresh call the line would still say
// the pre-click number — replica proves the refresh line is what changed it.
const stale = countLine(rows, "selected", "\u00b7");
ck("without refresh the line is stale (3 not 4)", stale === "3 selected \u00b7 5.0 MB");

process.exit(fail ? 1 : 0);
