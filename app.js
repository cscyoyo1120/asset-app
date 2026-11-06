/* 자산관리 PWA — 데이터는 각 사용자의 구글 드라이브 시트에 저장 */
const CLIENT_ID = "656294529343-jmpu8epnpq5l13kr1ihedjic8518s6ve.apps.googleusercontent.com"; // Google Cloud OAuth 클라이언트 ID (README 참고)
const SCOPE = "https://www.googleapis.com/auth/drive.file"; // 이 앱이 만든 파일에만 접근
const FILE_NAME = "자산관리";

const ASSET_CATS = ["예금·적금", "증권사 예수금", "기타"]; // 증권사 예수금은 주식 탭에서 보여줌, 대출은 대출 탭
const LOAN_KINDS = ["주택담보대출", "전세대출", "신용·기타"];

// 부동산 세금 설정 (2026년 시행 세법 기준). 법이 바뀌면 여기 숫자만 고치면 됨. 누진표는 [과세표준 상한, 세율] — 상한 Infinity가 마지막 구간
// ponytail: 대략 추정용. 생애최초·고령자·장기보유 공제, 세부담 상한, 지역자원시설세는 빠짐 → 실제 고지서보다 조금 많게 나올 수 있음
const TAX = {
  acq: {                                      // 취득세 (주택 매매)
    low: 6e8, high: 9e8,                      // 6억 이하 1%, 9억 초과 3%, 그 사이는 (취득가 × 2/3억 − 3)%
    heavy: { adjusted: [[2, 0.08], [3, 0.12]], normal: [[3, 0.08], [4, 0.12]] }, // [취득 후 주택 수 이상, 세율]
    eduRate: 0.1, eduHeavy: 0.004,            // 지방교육세: 일반은 취득세의 10%, 중과는 0.4%
    ruralArea: 85, rural: { 0.08: 0.006, 0.12: 0.01, base: 0.002 }, // 농특세: 전용 85㎡ 초과만
  },
  publicRatio: 0.7,                           // 공시가격을 안 넣으면 시세 × 이 비율로 추정
  prop: {                                     // 재산세 (주택)
    fmv: 0.6, fmvOne: [[3e8, 0.43], [6e8, 0.44], [Infinity, 0.45]], // 공정시장가액비율 (1세대1주택은 공시가격 구간별)
    rates: [[6e7, 0.001], [1.5e8, 0.0015], [3e8, 0.0025], [Infinity, 0.004]],
    oneLimit: 9e8,                            // 1세대1주택 특례세율: 공시가격 9억 이하
    ratesOne: [[6e7, 0.0005], [1.5e8, 0.001], [3e8, 0.002], [Infinity, 0.0035]],
    edu: 0.2, urban: 0.0014,                  // 지방교육세(재산세의 20%), 도시지역분(과세표준의 0.14%)
  },
  comp: {                                     // 종합부동산세 (공시가격 합계 기준)
    dedOne: 12e8, ded: 9e8, fmv: 0.6,         // 1세대1주택 12억, 그 외 9억 공제
    rates: [[3e8, 0.005], [6e8, 0.007], [12e8, 0.01], [25e8, 0.013], [50e8, 0.015], [94e8, 0.02], [Infinity, 0.027]],
    heavyFrom: 3,                             // 3주택 이상
    ratesHeavy: [[3e8, 0.005], [6e8, 0.007], [12e8, 0.01], [25e8, 0.02], [50e8, 0.03], [94e8, 0.04], [Infinity, 0.05]],
    rural: 0.2,                               // 농특세(종부세의 20%)
  },
};
const CAT_COLORS = { "예금·적금": "#3182F6", "부동산": "#1B4FA8", "전세 보증금": "#5E7FBF", "주식": "#8BBEFF", "기타": "#B0B8C1" };
const RENAMED_TABS = { "투자": "주식" }; // 예전 시트 탭 이름 → 새 이름

// 시트 구조: 시트 1행의 머리글(l)로 열을 찾으므로 사용자가 열 순서를 바꿔도 됨
const SHEETS = {
  // desc·ai: AI에게 줄 입력 형식 안내문(aiPrompt)에 쓰임
  assets: { title: "자산", desc: "현금성 자산: 은행 예금·적금·청약, CMA, 증권사 예수금 등 (주식·대출·부동산은 넣지 말 것)", fields: [
    { k: "category", l: "분류", t: "select", o: ASSET_CATS, ai: "증권사 계좌의 현금은 \"증권사 예수금\"" },
    { k: "name", l: "항목명", ai: "예: \"KB국민은행 입출금\", \"카카오뱅크 적금\"" },
    { k: "amount", l: "금액", t: "number" },
    { k: "memo", l: "메모" },
  ] },
  // only: 그 대출 종류일 때만 편집기에 보이고 저장됨
  loans: { title: "대출", desc: "대출: 주택담보대출, 전세대출, 신용대출 등. 월 상환액은 앱이 계산함. 전세대출이면 deposit에 전세 보증금", fields: [ // 월 상환액은 계산해서 고정지출에 자동 포함
    { k: "kind", l: "대출 종류", t: "select", o: LOAN_KINDS, ai: "신용대출·자동차 대출 등은 \"신용·기타\"" },
    { k: "name", l: "이름", ai: "예: \"우리은행 주담대\" (realestate.loans에서 이 이름을 씀)" },
    { k: "deposit", l: "전세 보증금", t: "number", only: "전세대출", hint: "자산으로 잡혀요", ai: "전세자금대출이면 전세 보증금(전세가), 아니면 0" },
    { k: "leaseEnd", l: "전세 만기일", t: "date", only: "전세대출", hint: "임대차 계약 끝나는 날", ai: "전세대출만, 전세 계약 만료일" },
    { k: "total", l: "총 대출금", t: "number", hint: "처음 빌린 금액" },
    { k: "remain", l: "잔여금액", t: "number", hint: "지금 남은 원금" },
    { k: "rate", l: "금리(%)", t: "number", ai: "연 금리 숫자, 예: 4.2" },
    { k: "years", l: "상환기간(년)", t: "number", hint: "전체 기간" },
    { k: "method", l: "상환방식", t: "select", o: ["원리금균등", "원금균등", "만기일시"] },
    { k: "start", l: "대출 시작일", t: "date", hint: "선택 · 낸 이자 계산용" },
    { k: "payDay", l: "출금일", t: "day", hint: "매월 며칠, 말일은 31" },
    { k: "account", l: "출금계좌" },
    { k: "memo", l: "메모" },
  ] },
  expenses: { title: "고정지출", desc: "매달 고정으로 나가거나 들어오는 돈: 보험, 통신비, 관리비, 구독, 적금 납입, 월급 등. 대출 상환액은 넣지 말 것(loans로 자동 계산)", fields: [
    { k: "kind", l: "구분", t: "select", o: ["지출", "수입"] },
    { k: "category", l: "분류", t: "list", ai: "예: 보험, 통신요금, 적금, 구독료, 관리비, 급여" },
    { k: "name", l: "내용" },
    { k: "company", l: "회사" },
    { k: "payDay", l: "출금일", t: "day", hint: "매월 며칠, 말일은 31" },
    { k: "amount", l: "금액", t: "number", ai: "월 금액" },
    { k: "method", l: "지불수단", ai: "출금 계좌나 카드" },
    { k: "memo", l: "비고" },
  ] },
  realestate: { title: "부동산", desc: "보유 부동산 (전세 보증금은 loans의 deposit으로)", fields: [
    { k: "name", l: "이름" },
    { k: "address", l: "주소", hint: "지번 주소 + 단지명이 실거래가 찾기에 정확해요. 예: 서울 마포구 상암동 1600 상암월드컵파크", ai: "아파트 주소 (지번 주소와 단지명이 있으면 같이). 모르면 \"\"" },
    { k: "unit", l: "동·호수", hint: "예: 101동 1203호" },
    { k: "area", l: "전용면적(㎡)", t: "number", hint: "평형 아님 · 34평형 ≈ 84㎡ · 실거래가 조회에 씀", ai: "전용면적 ㎡ 숫자, 모르면 0" },
    { k: "buyPrice", l: "매입가", t: "number", hint: "분양가 또는 매입가" },
    { k: "cost", l: "부대비용", t: "number", hint: "중개료·등기비 등, 선택 · 취득세는 자동 계산", ai: "중개료·등기비 등. 취득세는 넣지 말 것(앱이 계산)" },
    { k: "buyDate", l: "취득일", t: "date", hint: "잔금일 · 지금까지 낸 보유세 계산용, 선택" },
    { k: "homes", l: "취득 당시 주택 수", t: "number", hint: "이 집 포함 세대 기준 · 취득세율용, 비우면 1", ai: "모르면 0" },
    { k: "adjusted", l: "조정대상지역", t: "check", ai: "취득 당시 조정대상지역이면 true, 모르면 false" },
    { k: "curPrice", l: "현재 시세", t: "number", hint: "주변 시세 · 카드의 '실거래가 불러오기'로 자동 입력" },
    { k: "publicPrice", l: "공시가격", t: "number", hint: `보유세 계산용 · 비우면 시세 × ${TAX.publicRatio * 100}%로 추정`, ai: "공동주택 공시가격, 모르면 0" },
    { k: "loans", l: "연결 대출", t: "loans", ai: "이 부동산의 대출 이름. loans의 name과 똑같이, 여러 개면 \", \"로 연결. 없으면 \"\"" }, // 대출 탭 이름 목록 ("A, B")
    { k: "memo", l: "메모" },
    { k: "priceNote", l: "시세 근거", auto: true, ai: "앱이 채움, 항상 \"\"" }, // auto: 편집기에 안 보임, 실거래가 불러오기가 채움
  ] },
  invest: { title: "주식", desc: "보유 주식·ETF. 증권사 화면의 종목별 보유 현황", fields: [
    { k: "type", l: "구분", t: "list", ai: "계좌 종류, 예: 해외주식, 국내주식, ISA, 연금저축, 퇴직연금" },
    { k: "name", l: "종목명" },
    { k: "ticker", l: "티커", hint: "예: NASDAQ:AAPL, KRX:005930 — 넣으면 현재가 자동",
      ai: "거래소:코드 형식. 미국은 NASDAQ:AAPL, NYSE:V, NYSEARCA:VOO처럼. 한국은 KRX:6자리코드(예: KRX:005930, KRX:360750). 확실하지 않으면 \"\"" },
    { k: "foreign", l: "해외(달러)", t: "check", ai: "달러로 거래하는 종목이면 true" },
    { k: "buyPrice", l: "매입가", t: "number", ai: "1주당 평균 매입가 (해외 종목은 달러)" },
    { k: "curPrice", l: "현재가", t: "number", ai: "1주당 현재가 (해외 종목은 달러)" },
    { k: "qty", l: "수량", t: "number", ai: "보유 주식 수 (소수점 가능)" },
  ] },
  history: { title: "기록", fields: [ // 월별 스냅샷 (앱이 자동으로 이번 달 행을 갱신)
    { k: "month", l: "월", t: "month" },
    { k: "net", l: "순자산", t: "number" },
    { k: "total", l: "총자산", t: "number" },
    { k: "debt", l: "부채", t: "number" },
    { k: "invest", l: "주식", t: "number" },
  ] },
};
const SETTINGS_TITLE = "설정";

/* ---------- 상태 ---------- */
const $ = (s) => document.querySelector(s);
const ls = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const FX_DEFAULT = 1340; // 환율을 못 가져왔을 때만 쓰는 값
const emptyDb = () => ({ assets: [], loans: [], realestate: [], expenses: [], invest: [], history: [], fx: FX_DEFAULT });

let db = { ...emptyDb(), ...ls.get("db", {}) };
let mode = ls.get("mode", null);      // "google" | "local" | null
let dirty = ls.get("dirty", false);   // 시트에 아직 못 올린 변경이 있음
let token = ls.get("token", null);    // { v, exp }
let sheetId = null;
let lastLen = {};                     // 시트별 마지막으로 쓴 행 수 (남는 행 지우기용)
let lastHeader = {};                  // 시트별 마지막으로 읽은 머리글 (예전 열 지우기용)
let gen = 0;                          // 편집할 때마다 증가 → 진행 중인 저장/불러오기가 낡았는지 판단
let tab = "dash";

/* ---------- 유틸 ---------- */
const num = (v) => Number(String(v ?? "").replace(/,/g, "")) || 0;
const fmt = (n) => (n < 0 ? "-" : "") + Math.abs(Math.round(n)).toLocaleString("ko-KR") + "원";
const sign = (n) => (n >= 0 ? "+" : "") + fmt(n);
const pct = (n) => (n * 100).toFixed(1) + "%";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const today = () => new Date().toLocaleDateString("sv-SE"); // 로컬 날짜 YYYY-MM-DD (toISOString은 UTC라 오전 9시 전엔 어제가 됨)
const groupBy = (arr, k) => arr.reduce((m, r) => ((m[r[k] || "기타"] ||= []).push(r), m), {});
const lastDay = (y, m) => new Date(y, m, 0).getDate();
// 시트에서 직접 입력한 날짜는 일련번호(1899-12-30 기준 일수)로 옴
const toDate = (v) => (typeof v === "number" ? new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10) : String(v ?? ""));
const parseDay = (v) => (typeof v === "number" ? v : /말/.test(v) ? 31 : parseInt(v) || 0); // "25일", "31일(말일)", "없음"
const dayLabel = (d) => (!d ? "" : d >= 31 ? "말일" : `${d}일`);
const isIncome = (e) => e.kind === "수입";
const names = (s) => String(s || "").split(",").map((t) => t.trim()).filter(Boolean); // ponytail: 이름으로 연결 → 시트에서 대출 이름을 바꾸면 연결이 풀림 (앱에서 바꾸면 같이 바뀜)
// 종류를 안 고른 예전 대출: 보증금 있으면 전세, 부동산에 연결돼 있으면 주담대
const loanKind = (l) => LOAN_KINDS.includes(l.kind) ? l.kind : l.deposit ? "전세대출" : db.realestate.some((p) => names(p.loans).includes(l.name)) ? "주택담보대출" : "신용·기타";
// 1234567.5 → "1,234,567.5" (입력 중인 "12." "-"도 유지)
const withCommas = (s) => {
  s = String(s ?? "").replace(/[^\d.-]/g, "");
  const neg = s.startsWith("-"), [i, ...d] = s.replace(/-/g, "").split(".");
  return (neg ? "-" : "") + i.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d.length ? "." + d.join("") : "");
};
const fxLabel = (n) => num(n).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) + "원";

function setStatus(text, err) {
  const el = $("#status");
  el.textContent = text;
  el.className = err ? "err" : "";
}

/* ---------- 구글 인증 ---------- */
// ponytail: 브라우저 전용 토큰이라 1시간마다 만료 → 다음 터치 때 조용히 다시 받음(창이 잠깐 떴다 닫힘). 완전 자동 갱신은 서버가 있어야 가능
let tokenClient;
let auto = true; // 자동 재연결 시도 가능 (실패하면 배너로 직접 누르게 함)
const loginFailed = () => { $("#banner").hidden = false; setStatus("로그인 실패", true); };
function initAuth() {
  if (tokenClient || !window.google?.accounts?.oauth2 || !CLIENT_ID) return !!tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    error_callback: loginFailed, // 창을 닫았거나 못 열었을 때
    callback: (r) => {
      if (r.error) return loginFailed();
      auto = true;
      token = { v: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 };
      ls.set("token", token);
      mode = "google"; ls.set("mode", mode);
      $("#welcome").close();
      $("#banner").hidden = true;
      connect();
    },
  });
  return true;
}
function login() {
  if (!CLIENT_ID) return alert("app.js의 CLIENT_ID가 비어 있어요. README의 Google Cloud 설정을 먼저 해주세요.");
  if (!initAuth()) return alert("구글 로그인 모듈을 불러오는 중이에요. 잠시 후 다시 눌러주세요.");
  tokenClient.requestAccessToken({ prompt: "" });
}
const tokenOk = () => token && token.exp > Date.now();

async function api(url, opt = {}) {
  if (!tokenOk()) throw needLogin();
  const r = await fetch(url, { ...opt, headers: { Authorization: "Bearer " + token.v, "Content-Type": "application/json" } });
  if (r.status === 401) { token = null; ls.del("token"); throw needLogin(); }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// 보기만 할 땐 경고 없이 기기 데이터로 보여주고, 못 올린 변경이 있거나 자동 재연결이 실패했을 때만 배너
function needLogin() {
  $("#banner").hidden = !dirty && auto;
  setStatus(dirty ? "연결 끊김 · 저장 대기" : "누르면 다시 연결", dirty);
  return new Error("login");
}

/* ---------- 시트 동기화 ---------- */
const range = (title) => `'${title}'!A1:Z`;
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const allTitles = () => [...Object.values(SHEETS).map((s) => s.title), SETTINGS_TITLE];

async function findOrCreateSheet() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&orderBy=createdTime`);
  if (r.files.length) return { id: r.files[0].id, created: false };
  const s = await api(SHEETS_API, {
    method: "POST",
    body: JSON.stringify({ properties: { title: FILE_NAME }, sheets: allTitles().map((title) => ({ properties: { title } })) }),
  });
  return { id: s.spreadsheetId, created: true };
}

// 예전에 만든 시트: 이름이 바뀐 탭은 이름만 바꾸고, 새 탭(예: 기록, 부동산)은 추가
async function ensureTabs() {
  const meta = await api(`${SHEETS_API}/${sheetId}?fields=sheets.properties(sheetId,title)`);
  const props = meta.sheets.map((s) => s.properties);
  const have = props.map((p) => p.title);
  const requests = [];
  for (const [from, to] of Object.entries(RENAMED_TABS)) {
    const p = props.find((p) => p.title === from);
    if (p && !have.includes(to)) { requests.push({ updateSheetProperties: { properties: { sheetId: p.sheetId, title: to }, fields: "title" } }); have.push(to); }
  }
  allTitles().filter((t) => !have.includes(t)).forEach((title) => requests.push({ addSheet: { properties: { title } } }));
  if (requests.length) await api(`${SHEETS_API}/${sheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
}

async function connect() {
  try {
    setStatus("연결 중…");
    const f = await findOrCreateSheet();
    sheetId = f.id;
    if (!f.created) await ensureTabs();
    // 새 시트이거나 아직 못 올린 변경이 있으면 올리고, 아니면 시트를 기준으로 불러옴
    // ponytail: 마지막에 저장한 쪽이 이김. 여러 기기에서 동시에 편집하면 한쪽 변경이 덮일 수 있음
    if (f.created || dirty) await push();
    else await pull();
  } catch (e) {
    if (e.message !== "login") { console.error(e); setStatus("연결 실패", true); }
  }
}

async function pull() {
  if (!sheetId) return;
  const g = gen;
  setStatus("불러오는 중…");
  const keys = Object.keys(SHEETS);
  const ranges = allTitles().map((t) => "ranges=" + encodeURIComponent(range(t))).join("&");
  const get = (opt) => api(`${SHEETS_API}/${sheetId}/values:batchGet?${ranges}&valueRenderOption=${opt}`);
  const [vals, forms] = await Promise.all([get("UNFORMATTED_VALUE"), get("FORMULA")]);
  if (gen !== g || dirty) return; // 불러오는 사이에 편집했으면 버림 (편집 내용이 이김)
  const next = emptyDb();
  keys.forEach((k, i) => {
    const rows = vals.valueRanges[i].values || [];
    lastLen[k] = rows.length;
    lastHeader[k] = rows[0] || [];
    next[k] = fromRows(SHEETS[k].fields, rows, forms.valueRanges[i].values || []);
  });
  const settings = Object.fromEntries((vals.valueRanges[keys.length].values || []).map((r) => [r[0], r[1]]));
  next.fx = num(settings["환율"]) || db.fx || FX_DEFAULT;
  db = next;
  const moved = migrate();
  snapshot();
  ls.set("db", db);
  setStatus("동기화됨");
  render();
  // 예전 대출 행을 옮겼거나, 티커만 있고 시세 수식이 없으면(시트에 직접 입력) 한 번 저장
  if (moved || db.invest.some((r) => r.ticker && !r._f?.curPrice)) { dirty = true; ls.set("dirty", true); flush(); }
}

// 예전 버전: 자산 탭의 "대출" 분류 행 → 대출 탭으로 옮김 (금액은 총액·잔여금액 모두에 넣음)
function migrate() {
  const old = db.assets.filter((a) => a.category === "대출");
  if (!old.length) return false;
  old.forEach((a) => {
    const same = db.loans.find((l) => l.name.trim() === a.name.trim()); // 이미 있는 대출이면 잔여금액만 고침 (가져오기 중복 방지)
    if (same) same.remain = Math.abs(a.amount);
    else db.loans.push({ name: a.name, total: Math.abs(a.amount), remain: Math.abs(a.amount), rate: 0, years: 0, method: "원리금균등", start: "", payDay: 0, account: "", memo: a.memo });
  });
  db.assets = db.assets.filter((a) => a.category !== "대출");
  return true;
}

function fromRows(fields, rows, formRows) {
  const [header = [], ...body] = rows;
  const idx = fields.map((f) => header.indexOf(f.l));
  return body
    .map((row, r) => [row, formRows[r + 1] || []])
    .filter(([row]) => row.some((c) => c !== "" && c != null))
    .map(([row, frow]) => {
      const o = Object.fromEntries(fields.map((f, i) => {
        const v = idx[i] < 0 ? "" : row[idx[i]] ?? "";
        if (f.t === "number") return [f.k, num(v)];
        if (f.t === "day") return [f.k, parseDay(v)];
        if (f.t === "check") return [f.k, v === true || /^(y|yes|true|o|1)$/i.test(String(v).trim())];
        if (f.t === "date") return [f.k, toDate(v)];
        if (f.t === "month") return [f.k, toDate(v).slice(0, 7)];
        return [f.k, String(v)];
      }));
      // 시트에 직접 넣은 수식은 기억해뒀다가 저장할 때 그대로 다시 씀
      fields.forEach((f, i) => {
        const fv = frow[idx[i]];
        if (idx[i] >= 0 && typeof fv === "string" && fv.startsWith("=")) (o._f ||= {})[f.k] = fv;
      });
      return o;
    });
}

// USER_ENTERED로 쓰기: 수식은 수식으로, 글자는 앞에 '를 붙여 날짜·숫자로 바뀌지 않게
const text = (s) => (s === "" || s == null ? "" : "'" + s);

function cell(k, o, f) {
  // ponytail: 티커가 있으면 현재가는 GOOGLEFINANCE 수식(실패하면 마지막 값). 시세는 구글 기준 최대 20분 지연
  if (k === "invest" && f.k === "curPrice" && o.ticker) return `=IFERROR(GOOGLEFINANCE("${o.ticker.replace(/"/g, "")}","price"),${num(o.curPrice)})`;
  // ponytail: 사용자 수식은 그대로 다시 씀. 같은 행을 참조하는 수식(B2 등)은 앱에서 위쪽 행을 지우면 어긋날 수 있음
  if (o._f?.[f.k]) return o._f[f.k];
  const v = o[f.k];
  if (f.t === "check") return v ? "'Y" : "";
  if (f.t === "day") return v || "";
  if (typeof v === "number") return v;
  return text(v);
}

// 예전 버전이 쓰던 열 (지금은 다른 탭에서 관리) → 시트에서 지움
const OLD_COLS = { realestate: ["대출금", "금리(%)", "상환기간(년)", "상환방식", "대출 시작일"] };

// 시트에 이미 있는 열은 그 자리에 쓰고, 새 열은 빈 자리(지운 예전 열 등) → 맨 뒤 순으로. 사용자가 바꾼 열 순서·추가한 열은 그대로
function toRows(k) {
  const { fields } = SHEETS[k], old = lastHeader[k] || [];
  const col = fields.map((f) => old.indexOf(f.l));
  // 비워도 되는 열: 빈 머리글, 예전 버전 열, 같은 이름 중복 열
  const free = old.map((h, j) => !col.includes(j) && (!h || (OLD_COLS[k] || []).includes(h) || fields.some((f) => f.l === h)));
  let next = old.length;
  col.forEach((c, i) => { if (c < 0) { const j = free.indexOf(true); col[i] = j >= 0 ? j : next++; if (j >= 0) free[j] = false; } });
  const blank = Array.from({ length: Math.max(next, old.length) }, (_, j) => (free[j] || col.includes(j) ? "" : null)); // null은 API가 건너뜀
  const line = (vals) => { const r = [...blank]; col.forEach((c, i) => (r[c] = vals[i])); return r; };
  const rows = [line(fields.map((f) => text(f.l))), ...db[k].map((o) => line(fields.map((f) => cell(k, o, f))))];
  // 이전보다 줄어든 만큼 빈 칸으로 덮어서 지움 (한 번의 요청으로 처리)
  while (rows.length < (lastLen[k] || 0)) rows.push([...blank]);
  rows.header = blank.map((v, j) => (v === null ? old[j] : "")); // 저장 뒤 lastHeader
  col.forEach((c, i) => (rows.header[c] = fields[i].l));
  return rows;
}

const settingsRows = () => [
  [text("항목"), text("값")],
  [text("환율"), `=IFERROR(GOOGLEFINANCE("CURRENCY:USDKRW"),${num(db.fx) || FX_DEFAULT})`],
  ["", ""], // 예전 버전의 "고정지출 반영일" 행 지우기
];

let pushQ = Promise.resolve();
const push = () => (pushQ = pushQ.catch(() => {}).then(doPush)); // 저장은 한 번에 하나씩

async function doPush() {
  if (!sheetId) return;
  const g = gen;
  setStatus("저장 중…");
  const keys = Object.keys(SHEETS);
  // 불러온 적 없는 기존 시트에 저장할 때: 머리글·행 수를 먼저 읽어야 열 순서를 지키고 남는 행을 지움
  if (keys.some((k) => !(k in lastLen))) {
    const ranges = keys.map((k) => "ranges=" + encodeURIComponent(range(SHEETS[k].title))).join("&");
    const r = await api(`${SHEETS_API}/${sheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
    keys.forEach((k, i) => { const rows = r.valueRanges[i].values || []; lastLen[k] = rows.length; lastHeader[k] = rows[0] || []; });
  }
  const data = keys.map((k) => ({ range: range(SHEETS[k].title), values: toRows(k) }));
  data.push({ range: range(SETTINGS_TITLE), values: settingsRows() });
  await api(`${SHEETS_API}/${sheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  keys.forEach((k, i) => { lastLen[k] = data[i].values.length; lastHeader[k] = data[i].values.header; });
  if (gen === g) { dirty = false; ls.set("dirty", false); } // 저장하는 사이에 또 고쳤으면 dirty 유지
  setStatus("저장됨");
  // 시세 수식을 다시 썼으니 계산된 값을 받아옴
  if (!dirty && db.invest.some((r) => r.ticker)) await pull();
}

let saveTimer, retryTimer;
function flush() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  if (mode !== "google" || !dirty) return;
  if (!sheetId || !tokenOk()) return tokenOk() ? connect() : needLogin();
  push().catch((e) => {
    if (e.message === "login") return;
    console.error(e);
    setStatus("저장 실패 · 30초 뒤 다시 시도", true);
    retryTimer = setTimeout(flush, 30000);
  });
}

function changed() {
  gen++;
  snapshot();
  ls.set("db", db);
  render();
  if (mode !== "google") return setStatus("이 기기에 저장됨");
  dirty = true; ls.set("dirty", true);
  setStatus("저장 대기…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 800);
}

/* ---------- 자동 처리 ---------- */
// 체험 모드 환율: ECB 기준(하루 한 번 갱신). 구글 모드는 시트의 GOOGLEFINANCE 값을 씀
async function loadFx() {
  try {
    const r = await (await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW")).json();
    if (r.rates?.KRW) { db.fx = r.rates.KRW; ls.set("db", db); render(); }
  } catch {}
}

// 이번 달 순자산 기록을 최신 값으로 갱신
function snapshot() {
  const c = calc();
  const row = { month: today().slice(0, 7), net: Math.round(c.net), total: Math.round(c.net - c.debt), debt: Math.round(-c.debt), invest: Math.round(c.investTotal) };
  const i = db.history.findIndex((h) => h.month === row.month);
  if (i < 0) { db.history.push(row); db.history.sort((a, b) => a.month.localeCompare(b.month)); }
  else Object.assign(db.history[i], row);
}

/* ---------- 계산 ---------- */
const monthsSince = (d) => {
  if (!d) return 0;
  const [y, m, dd] = d.split("-").map(Number), [Y, M, D] = today().split("-").map(Number);
  return Math.max(0, (Y - y) * 12 + (M - m) - (D < dd ? 1 : 0));
};

// 대출 k개월 경과 시점: 월 상환액, 낸 이자, 만기까지 총 이자, 남은 원금
function loanInfo({ loan: P, rate, years, method, start }) {
  const n = Math.round(years * 12), r = rate / 100 / 12, k = Math.min(n, monthsSince(start));
  if (!P || !n) return { pmt: 0, paid: 0, total: 0, bal: P || 0 };
  let pmt, interest, bal;
  if (method === "원금균등") {
    interest = (k) => r * P * (k - (k * (k - 1)) / (2 * n));
    bal = (k) => P * (1 - k / n);
    pmt = P / n + bal(k) * r; // 이번 달 상환액 (점점 줄어듦)
  } else if (method === "만기일시") {
    interest = (k) => P * r * k;
    bal = (k) => (k >= n ? 0 : P);
    pmt = P * r;
  } else { // 원리금균등
    pmt = r ? (P * r) / (1 - (1 + r) ** -n) : P / n;
    bal = (k) => (r ? P * (1 + r) ** k - (pmt * ((1 + r) ** k - 1)) / r : P - pmt * k);
    interest = (k) => pmt * k - (P - bal(k));
  }
  return { pmt, paid: interest(k), total: interest(n), bal: Math.max(0, bal(k)) };
}

// 이번 달 상환액: 원리금균등은 총 대출금·전체 기간으로 고정액, 원금균등은 원금 몫 + 잔여금액 이자, 만기일시는 잔여금액 이자
function loanPay({ total, remain, rate, years, method }) {
  const r = rate / 100 / 12, n = Math.round(years * 12), P = total || remain;
  const interest = remain * r;
  if (method === "만기일시" || !n) return { pmt: interest, interest }; // 기간을 모르면 이자만
  if (method === "원금균등") return { pmt: P / n + interest, interest };
  return { pmt: r ? (P * r) / (1 - (1 + r) ** -n) : P / n, interest };
}

// 부동산: 연결한 대출(대출 탭)로 이자·본전 시세 계산 → 대출을 고치면 바로 반영됨
function reInfo(p, loans, hold) {
  const mine = loans.filter((l) => names(p.loans).includes(l.name));
  const L = mine.map((l) => loanInfo({ loan: l.total || l.remain, rate: l.rate, years: l.years, method: l.method, start: l.start }));
  const paid = sum(L, (x) => x.paid), total = sum(L, (x) => x.total);
  const acq = acqTax(p);
  const holdPaid = hold.total * (monthsSince(p.buyDate) / 12); // ponytail: 지금 세율·공시가격으로 지난 해도 계산 → 공시가격이 많이 바뀌었으면 어긋남
  const base = p.buyPrice + p.cost + acq.total;
  const beNow = base + paid + holdPaid, beEnd = base + total; // 본전 시세: 매입가 + 부대비용 + 취득세 + 이자 (+ 지금까지 낸 보유세)
  return {
    ...p, mine, paid, total, beNow, beEnd, acq, hold, holdPaid,
    bal: sum(mine, (l) => l.remain), pmt: sum(mine, (l) => l.pmt),
    gain: p.curPrice - p.buyPrice,                   // 시세차익
    real: p.curPrice - beNow,                        // 세금·이자·비용까지 뺀 실제 손익
    yearly: p.curPrice ? (sum(mine, (l) => l.interest * 12) + hold.total) / p.curPrice : 0, // (1년 이자 + 보유세) ÷ 시세 = 매년 이만큼 올라야 상쇄
  };
}

/* ---------- 부동산 세금 (세율은 맨 위 TAX) ---------- */
// 누진세: table = [[구간 상한, 세율], …]
const progressive = (base, table) => {
  let tax = 0, lo = 0;
  for (const [hi, r] of table) { if (base <= lo) break; tax += (Math.min(base, hi) - lo) * r; lo = hi; }
  return tax;
};
const bracket = (v, table) => table.find(([hi]) => v <= hi)[1];

// 취득세 + 지방교육세 + 농특세
function acqTax(p) {
  const A = TAX.acq, price = p.buyPrice || 0, n = Math.max(1, p.homes || 1);
  const heavy = [...A.heavy[p.adjusted ? "adjusted" : "normal"]].reverse().find(([from]) => n >= from)?.[1];
  const rate = heavy || (price <= A.low ? 0.01 : price > A.high ? 0.03 : Math.round((price / 1e8 * 2 / 3 - 3) * 100) / 1e4);
  const tax = price * rate, edu = heavy ? price * A.eduHeavy : tax * A.eduRate;
  const rural = p.area > A.ruralArea ? price * (A.rural[heavy] ?? A.rural.base) : 0;
  return { rate, tax, edu, rural, total: tax + edu + rural };
}

// 보유세: 재산세(+지방교육세·도시지역분)는 집마다, 종부세는 공시가격 합계로 계산해 공시가격 비율로 나눔. 등록한 부동산 수 = 보유 주택 수
function holdTaxes(list) {
  const P = TAX.prop, C = TAX.comp, one = list.length === 1;
  const per = list.map((p) => {
    const pub = p.publicPrice || (p.curPrice || 0) * TAX.publicRatio;
    const base = pub * (one ? bracket(pub, P.fmvOne) : P.fmv);
    const prop = progressive(base, one && pub <= P.oneLimit ? P.ratesOne : P.rates);
    return { pub, estimated: !p.publicPrice, base, prop, propAll: prop * (1 + P.edu) + base * P.urban };
  });
  const pubSum = sum(per, (x) => x.pub), baseSum = sum(per, (x) => x.base);
  const compBase = Math.max(0, pubSum - (one ? C.dedOne : C.ded)) * C.fmv;
  // 종부세 과세표준에 겹치는 재산세는 빼줌
  const overlap = baseSum ? sum(per, (x) => x.prop) * Math.min(1, (compBase * P.fmv) / baseSum) : 0;
  const comp = Math.max(0, progressive(compBase, list.length >= C.heavyFrom ? C.ratesHeavy : C.rates) - overlap);
  return per.map((x) => {
    const compAll = pubSum ? comp * (1 + C.rural) * (x.pub / pubSum) : 0;
    return { ...x, compAll, total: x.propAll + compAll };
  });
}

/* ---------- 실거래가 (국토교통부 아파트 매매 실거래가 · 공공데이터포털 서비스키 필요) ---------- */
const RTMS = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";
const REGION = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList"; // 주소 → 시군구 코드
const SIDO = { 서울: "서울특별시", 서울시: "서울특별시", 부산: "부산광역시", 대구: "대구광역시", 인천: "인천광역시", 광주: "광주광역시", 대전: "대전광역시", 울산: "울산광역시",
  세종: "세종특별자치시", 경기: "경기도", 강원: "강원특별자치도", 강원도: "강원특별자치도", 충북: "충청북도", 충남: "충청남도", 전북: "전북특별자치도", 전라북도: "전북특별자치도",
  전남: "전라남도", 경북: "경상북도", 경남: "경상남도", 제주: "제주특별자치도", 제주도: "제주특별자치도" };

// "경기 성남시 분당구 정자동 123-4 ○○아파트" → 시도·시군구·동·지번·단지명. 도로명 주소면 동·지번 없이 단지명으로만 찾음
function parseAddr(s) {
  const t = String(s || "").replace(/[(),]/g, " ").split(/\s+/).filter(Boolean);
  const sido = SIDO[t[0]] || t[0] || "", sgg = [];
  let i = 1;
  while (i < t.length && /[시군구]$/.test(t[i]) && !/\d/.test(t[i])) sgg.push(t[i++]);
  const road = t.slice(i).some((x) => /\D(로|길)$/.test(x) || /\d+번?길$/.test(x));
  const umd = !road && /[동가읍면]$/.test(t[i] || "") ? t[i++] : "";
  const rest = t.slice(i).filter((x) => !/^\d+(동|호|층)$/.test(x) && !/(로|길)$/.test(x));
  const jibun = road ? "" : rest.find((x) => /^산?\d+(-\d+)?(번지)?$/.test(x))?.replace("번지", "") || "";
  const apt = rest.filter((x) => !/^산?\d+(-\d+)?(번지)?$/.test(x)).join("");
  return { sido, sgg: sgg.join(" "), umd, jibun, apt };
}

const squash = (s) => String(s || "").replace(/\s|아파트|APT/gi, "");
// 같은 단지(동+지번, 없으면 단지명) + 전용면적 ±1㎡, 해제된 거래 제외
const pickTrades = (items, a, area) => items.filter((x) => x.cdealType !== "O"
  && (!a.umd || x.umdNm === a.umd)
  && (a.jibun ? x.jibun === a.jibun : a.apt && squash(x.aptNm) && (squash(x.aptNm).includes(squash(a.apt)) || squash(a.apt).includes(squash(x.aptNm))))
  && (!area || Math.abs(num(x.excluUseAr) - area) <= 1));
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ymAgo = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); return d.toLocaleDateString("sv-SE").slice(0, 7).replace("-", ""); };
const keyParam = (k) => "serviceKey=" + (k.includes("%") ? k : encodeURIComponent(k)); // 인코딩 키·디코딩 키 둘 다 받음

async function lawdCode(a, key) {
  const cache = ls.get("lawd", {}), q = `${a.sido} ${a.sgg}`;
  if (cache[q]) return cache[q];
  if (!a.sgg) throw new Error("주소에서 시·군·구를 못 찾았어요 (예: 서울 마포구 상암동 …)");
  const j = await (await fetch(`${REGION}?${keyParam(key).replace("serviceKey", "ServiceKey")}&type=json&pageNo=1&numOfRows=1000&flag=Y&locatadd_nm=${encodeURIComponent(a.sgg)}`)).json().catch(() => ({}));
  const rows = (j.StanReginCd || []).flatMap((x) => x.row || []);
  if (!rows.length) throw new Error(j.RESULT?.resultMsg || j.response?.header?.resultMsg || "법정동코드 조회 실패 · 공공데이터포털에서 '행정안전부_법정동코드' 활용신청을 했는지 확인해주세요");
  const hit = rows.filter((r) => r.umd_cd === "000" && r.locatadd_nm.endsWith(a.sgg))
    .sort((x, y) => y.locatadd_nm.startsWith(a.sido) - x.locatadd_nm.startsWith(a.sido))[0];
  if (!hit) throw new Error(`'${a.sgg}'의 지역코드를 못 찾았어요`);
  ls.set("lawd", { ...cache, [q]: hit.region_cd.slice(0, 5) });
  return hit.region_cd.slice(0, 5);
}

const tradeCache = {}; // 시군구+월 → 거래 목록 (여러 부동산이 같이 씀)
function monthTrades(lawd, ym, key) {
  return (tradeCache[lawd + ym] ||= (async () => {
    const out = [];
    for (let page = 1; ; page++) {
      const xml = new DOMParser().parseFromString(await (await fetch(`${RTMS}?${keyParam(key)}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=1000&pageNo=${page}`)).text(), "text/xml");
      const code = xml.querySelector("resultCode")?.textContent.trim();
      if (!code || !/^0+$/.test(code)) {
        delete tradeCache[lawd + ym];
        throw new Error(xml.querySelector("returnAuthMsg, resultMsg")?.textContent.trim() || "실거래가 조회 실패");
      }
      const items = [...xml.querySelectorAll("item")].map((el) => Object.fromEntries([...el.children].map((c) => [c.tagName, c.textContent.trim()])));
      out.push(...items);
      if (!items.length || out.length >= num(xml.querySelector("totalCount")?.textContent)) return out;
    }
  })());
}

// 최근 3개월 → 없으면 6개월 → 없으면 1년. 그 기간 거래가의 중앙값을 시세로
async function realPrice(p, key) {
  const a = parseAddr(p.address);
  if (!a.jibun && !a.apt) throw new Error("주소에 지번이나 단지명을 넣어주세요 (예: … 상암동 1600 상암월드컵파크)");
  const lawd = await lawdCode(a, key);
  let got = [];
  for (const [from, to] of [[0, 3], [3, 6], [6, 12]]) {
    const months = await Promise.all(Array.from({ length: to - from }, (_, k) => monthTrades(lawd, ymAgo(from + k), key)));
    got.push(...pickTrades(months.flat(), a, num(p.area)));
    if (!got.length) continue;
    const deals = got.map((x) => ({ price: num(x.dealAmount) * 10000, date: `${x.dealYear}.${String(x.dealMonth).padStart(2, "0")}.${String(x.dealDay).padStart(2, "0")}` }))
      .sort((x, y) => y.date.localeCompare(x.date));
    return { price: median(deals.map((d) => d.price)), deals,
      note: `최근 ${to}개월 실거래 ${deals.length}건 중앙값 · 마지막 ${deals[0].date} ${fmt(deals[0].price)} (${today()} 조회)` };
  }
  throw new Error(`최근 1년 동안 ${a.umd || a.sgg} ${a.jibun || a.apt}${num(p.area) ? ` 전용 ${p.area}㎡` : ""} 거래가 없어요. 주소·면적을 확인해주세요`);
}

async function reprice(i) {
  const p = db.realestate[i];
  let key = ls.get("molitKey", "");
  if (!key && !(key = askKey())) return;
  setStatus("실거래가 조회 중…");
  try {
    const r = await realPrice(p, key);
    const cur = db.realestate.find((x) => x.name === p.name) || p; // 조회하는 사이에 시트를 다시 불러왔을 수 있음
    cur.curPrice = r.price; cur.priceNote = r.note;
    if (cur._f) delete cur._f.curPrice;
    changed();
  } catch (e) {
    console.warn(e);
    if (/SERVICE_KEY|서비스키|인증/i.test(e.message)) ls.del("molitKey"); // 다음에 다시 물어봄
    setStatus("실거래가 조회 실패", true);
    alert(e.message === "Failed to fetch" ? "인터넷 연결을 확인해주세요" : e.message);
  }
}
function askKey() {
  const k = (prompt("공공데이터포털(data.go.kr) 일반 인증키를 붙여넣어 주세요.\n'국토교통부_아파트 매매 실거래가 자료'와 '행정안전부_법정동코드' 활용신청이 필요해요. (README 참고)", ls.get("molitKey", "")) || "").trim();
  if (k) ls.set("molitKey", k);
  return k;
}

function calc() {
  const inv = db.invest.map((r) => {
    const m = r.foreign ? num(db.fx) : 1;
    const evalAmt = r.curPrice * r.qty * m, buyAmt = r.buyPrice * r.qty * m;
    return { ...r, evalAmt, gain: evalAmt - buyAmt, rate: buyAmt ? (evalAmt - buyAmt) / buyAmt : 0 };
  });
  const loans = db.loans.map((l) => ({ ...l, ...loanPay(l) }));
  const byCat = {};
  db.assets.forEach((a) => (byCat[a.category] = (byCat[a.category] || 0) + a.amount));
  const investTotal = sum(inv, (r) => r.evalAmt);
  const loanPayTotal = sum(loans, (l) => l.pmt);
  const taxes = holdTaxes(db.realestate);
  const re = db.realestate.map((p, i) => reInfo(p, loans, taxes[i]));
  const taxMonthly = sum(taxes, (t) => t.total) / 12; // 보유세는 7·9·12월에 내지만 월 환산으로 고정지출에 넣음
  const fixedIn = sum(db.expenses.filter(isIncome), (e) => e.amount);
  const fixedOut = sum(db.expenses.filter((e) => !isIncome(e)), (e) => e.amount) + loanPayTotal + taxMonthly;
  // 이번 달 남은 출금(오늘 포함): 고정지출 + 대출 상환
  const [y, m, d] = today().split("-").map(Number);
  const due = (day) => day && Math.min(day, lastDay(y, m)) >= d;
  const upcoming = [
    ...db.expenses.filter((e) => !isIncome(e) && due(e.payDay)).map((e) => ({ src: "expenses", ref: e, name: e.name, payDay: e.payDay, amount: e.amount })),
    ...loans.filter((l) => l.pmt && due(l.payDay)).map((l) => ({ src: "loans", ref: db.loans[loans.indexOf(l)], name: l.name + " 상환", payDay: l.payDay, amount: l.pmt })),
  ].sort((a, b) => a.payDay - b.payDay);
  const reValue = sum(re, (p) => p.curPrice);
  const debt = -sum(loans, (l) => l.remain); // 음수. 부동산에 연결된 대출도 여기서 한 번만 셈
  const jeonse = sum(loans, (l) => l.deposit || 0); // 전세 보증금은 자산, 전세대출은 위 debt에서 빠짐
  return {
    inv, byCat, investTotal, fixedIn, fixedOut, upcoming, re, reValue, jeonse, loans, loanPayTotal, taxMonthly, debt,
    investGain: sum(inv, (r) => r.gain),
    deposit: byCat["예금·적금"] || 0,
    cash: byCat["증권사 예수금"] || 0,
    net: sum(db.assets, (a) => a.amount) + investTotal + reValue + jeonse + debt,
  };
}

/* ---------- 화면 ---------- */
// 손익 색: 한국식 (상승 빨강 / 하락 파랑)
const updown = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");

const stat = (label, value, { cls = "", sub = "", hero = false, wide = false } = {}) =>
  `<div class="stat${hero ? " hero" : ""}${wide ? " wide" : ""}"><div class="l">${label}</div><div class="v ${cls}">${value}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;

const rowLi = (sheet, r, name, sub, amt, cls = "") =>
  `<li data-sheet="${sheet}" data-i="${db[sheet].indexOf(r)}"><div class="main"><div class="name">${esc(name)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div><div class="amt ${cls}">${amt}</div></li>`;

const section = (title, total, items, sheet, prefill, color) => `
  <div class="card">
    <h4><span>${color ? `<span class="dot" style="background:${color}"></span>` : ""}${esc(title)}</span><span class="sum">${fmt(total)}</span></h4>
    <ul class="rows">${items.join("") || `<li class="empty">항목 없음</li>`}</ul>
    <button class="add" data-add="${sheet}" data-prefill='${esc(JSON.stringify(prefill))}'>+ 추가</button>
  </div>`;

const assetSection = (cat) => {
  const rows = db.assets.filter((a) => a.category === cat);
  return section(cat, sum(rows, (r) => r.amount), rows.map((r) => rowLi("assets", r, r.name, r.memo, fmt(r.amount))), "assets", { category: cat }, CAT_COLORS[cat]);
};

// 대출 한 줄: 잔여금액 + 월 상환액, 조건 요약
const loanLi = (l, c) => {
  const home = c.re.filter((p) => p.mine.some((x) => x.name === l.name)).map((p) => p.name);
  const sub = l.rate || l.years
    ? [loanKind(l), l.rate && `${l.rate}%`, l.years && `${l.years}년`, l.method, l.total && `${pct(1 - l.remain / l.total)} 상환`, home.length && home.join(", ")].filter(Boolean).join(" · ")
    : "금리·상환기간을 넣으면 월 상환액이 계산돼요";
  return rowLi("loans", db.loans[c.loans.indexOf(l)], l.name, sub, `${fmt(-l.remain)}<div class="small muted">월 ${fmt(l.pmt)}</div>`);
};

const ratio = (a, b) => (b ? pct(a / b) : "-");
const kv = (k, v, cls = "") => `<div class="kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;

function reCard(p, i) {
  const left = p.beNow - p.curPrice; // 본전까지 남은 상승액
  return `<div class="re" data-sheet="realestate" data-i="${i}">
    <div class="re-head"><div class="main"><div class="name">${esc(p.name)}</div>${p.address || p.unit ? `<div class="sub">${esc([p.address, p.unit].filter(Boolean).join(" "))}</div>` : ""}<div class="sub">매입 ${fmt(p.buyPrice)} → 시세 ${fmt(p.curPrice)}</div></div>
      <div class="amt ${updown(p.gain)}">${sign(p.gain)}<div class="small">${ratio(p.gain, p.buyPrice)}</div></div></div>
    ${p.address ? `<div class="price-src"><span class="muted small">${p.priceNote ? esc(p.priceNote) : "실거래가로 현재 시세를 채울 수 있어요"}</span><button type="button" class="refresh" data-reprice="${i}">실거래가 불러오기</button></div>` : ""}
    ${kv("실제 손익 <small>(세금·비용·이자 반영)</small>", sign(p.real), updown(p.real))}
    ${p.mine.length
      ? `<div class="re-loans">${p.mine.map((l) => `<div class="kv"><span>${esc(l.name)}<small><br>${[l.rate && `${l.rate}%`, l.years && `${l.years}년`, l.method, !l.start && "시작일 없음"].filter(Boolean).join(" · ")}</small></span><b>${fmt(l.remain)}<small><br>월 ${fmt(l.pmt)}</small></b></div>`).join("")}</div>`
        + kv("대출 잔액 합계", fmt(p.bal)) + kv("월 상환액 합계", fmt(p.pmt)) + kv("지금까지 낸 이자 <small>(시작일 기준)</small>", fmt(p.paid))
      : `<div class="muted small" style="margin:6px 0">대출이 있으면 눌러서 대출 탭의 대출을 연결하세요. 이자까지 반영해 손익을 계산해요.</div>`}
    ${p.buyPrice ? kv(`취득세 <small>(${+(p.acq.rate * 100).toFixed(2)}% · 교육세·농특세 포함)</small>`, fmt(p.acq.total)) : ""}
    ${p.hold.total ? kv(`보유세 <small>(연 추정 · 공시가 ${fmt(p.hold.pub)}${p.hold.estimated ? " 추정" : ""})</small>`,
      `${fmt(p.hold.total)}<small><br>재산세 ${fmt(p.hold.propAll)}${p.hold.compAll ? ` · 종부세 ${fmt(p.hold.compAll)}` : ""}</small>`) : ""}
    ${p.holdPaid ? kv("지금까지 낸 보유세 <small>(취득일 기준)</small>", fmt(p.holdPaid)) : ""}
    ${kv("본전 시세 <small>(지금)</small>", `${fmt(p.beNow)} <small>(+${ratio(p.beNow - p.buyPrice, p.buyPrice)})</small>`)}
    <div class="verdict ${left > 0 ? "" : "ok"}">${left > 0 ? `시세가 ${fmt(left)} 더 올라야 본전이에요` : `본전보다 ${fmt(-left)} 높아요`}</div>
    ${p.total ? kv("만기까지 총 이자", fmt(p.total)) + kv("본전 시세 <small>(만기)</small>", `${fmt(p.beEnd)} <small>(+${ratio(p.beEnd - p.buyPrice, p.buyPrice)})</small>`) : ""}
    ${p.yearly ? kv("이자·보유세만큼 오르려면", `매년 ${pct(p.yearly)} 이상`) : ""}
  </div>`;
}

function trendChart(hist) {
  const pts = hist.slice(-12);
  if (pts.length < 2) return `<div class="empty">매달 순자산이 「기록」 시트에 자동으로 쌓여요. 다음 달부터 추이가 보여요.</div>`;
  const W = 320, H = 140, P = 10;
  const vals = pts.map((p) => p.net), lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v) => H - P - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (H - 2 * P);
  const line = pts.map((p, i) => `${x(i)},${y(p.net)}`).join(" ");
  const last = pts.length - 1;
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="월별 순자산 추이">
      <polyline points="${P},${H - P} ${line} ${x(last)},${H - P}" class="area"/>
      <polyline points="${line}" class="line"/>
      <circle cx="${x(last)}" cy="${y(pts[last].net)}" r="4" class="pt"/>
    </svg>
    <div class="axis"><span>${pts[0].month.replace("-", ".")}</span><span>${pts[last].month.replace("-", ".")}</span></div>
    <ul class="rows">${pts.slice(-3).reverse().map((p) => `<li class="static"><div class="main"><div class="name">${p.month.replace("-", "년 ")}월</div></div><div class="amt">${fmt(p.net)}</div></li>`).join("")}</ul>`;
}

// 대시보드 부동산·대출: 매매(시세 − 연결 대출) / 전세(보증금 − 전세대출) / 그 밖의 대출
function propCard(c) {
  if (!c.re.length && !c.loans.length) return "";
  const linked = new Set(c.re.flatMap((p) => p.mine.map((l) => l.name)));
  const jl = c.loans.filter((l) => l.deposit);
  const rl = c.loans.filter((l) => !l.deposit && linked.has(l.name));
  const other = c.loans.filter((l) => !l.deposit && !linked.has(l.name));
  const loanKv = (l, label = l.name) => kv(`<small>└</small> ${esc(label)}`, `${fmt(-l.remain)}<small><br>월 ${fmt(l.pmt)}</small>`);
  const block = (title, net, body) => `<div class="pgrp"><div class="kv head"><span>${title}</span><b>${fmt(net)}</b></div>${body}</div>`;
  return `<div class="card"><h4>부동산 · 대출 <span class="sum">${fmt(c.reValue + c.jeonse + c.debt)}</span></h4>
    ${c.re.length ? block("매매 부동산 <small>시세 − 대출</small>", c.reValue - sum(rl, (l) => l.remain),
      c.re.map((p) => kv(esc(p.name), fmt(p.curPrice)) + p.mine.filter((l) => !l.deposit).map((l) => loanKv(l)).join("")).join("")) : ""}
    ${jl.length ? block("전세 <small>보증금 − 대출</small>", c.jeonse - sum(jl, (l) => l.remain),
      jl.map((l) => kv(`${esc(l.name)} 보증금`, fmt(l.deposit)) + loanKv(l, "전세대출")).join("")) : ""}
    ${other.length ? block("기타 대출", -sum(other, (l) => l.remain), other.map((l) => loanKv(l)).join("")) : ""}
    ${kv("대출 잔액 합계", `${fmt(c.debt)}<small><br>월 ${fmt(c.loanPayTotal)}</small>`)}
  </div>`;
}

const views = {
  dash(c) {
    const parts = [["예금·적금", c.deposit], ["부동산", c.reValue], ["전세 보증금", c.jeonse], ["주식", c.investTotal + c.cash], ["기타", c.byCat["기타"] || 0]].filter(([, v]) => v > 0);
    const total = sum(parts, ([, v]) => v);
    let acc = 0;
    const grad = parts.map(([k, v]) => `${CAT_COLORS[k]} ${(acc / total) * 360}deg ${((acc += v) / total) * 360}deg`).join(",");
    const exp = [...Object.entries(groupBy(db.expenses.filter((e) => !isIncome(e)), "category")).map(([k, rows]) => [k, sum(rows, (r) => r.amount)]), ["대출 상환", c.loanPayTotal], ["보유세", c.taxMonthly]]
      .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const maxExp = Math.max(1, ...exp.map(([, v]) => v));
    const prev = db.history.filter((h) => h.month < today().slice(0, 7)).at(-1);
    const diff = prev ? c.net - prev.net : null;
    return `
      <div class="stats">
        ${stat("순자산", fmt(c.net), { hero: true, sub: diff == null ? "자산 − 부채" : `지난달보다 <span class="${updown(diff)}">${sign(diff)}</span>` })}
        ${stat("예금·적금", fmt(c.deposit))}
        ${stat("주식 <small>(예수금 포함)</small>", fmt(c.investTotal + c.cash), { sub: `<span class="${updown(c.investGain)}">${sign(c.investGain)}</span>` })}
        ${stat("월 여유자금", fmt(c.fixedIn - c.fixedOut), { cls: c.fixedIn - c.fixedOut < 0 ? "up" : "", sub: "고정수입 − 고정지출" })}
        ${stat("이번 달 남은 출금", fmt(sum(c.upcoming, (e) => e.amount)), { sub: `${c.upcoming.length}건 남음` })}
        ${stat("달러 환율", fxLabel(db.fx), { wide: true, sub: mode === "google" ? "구글 파이낸스" : "ECB 기준 · 매일 갱신" })}
      </div>
      ${propCard(c)}
      <div class="card"><h4>순자산 추이</h4>${trendChart(db.history)}</div>
      <div class="card"><h4>자산 구성 <span class="muted small">부채 제외</span></h4>
        ${total ? `<div class="donut" style="background:conic-gradient(${grad})" role="img" aria-label="자산 구성 도넛 차트"></div>
        <div class="legend">${parts.map(([k, v]) => `<div><span class="dot" style="background:${CAT_COLORS[k]}"></span><span class="grow">${k}</span><b>${pct(v / total)}</b></div>`).join("")}</div>`
        : `<div class="empty">자산 탭에서 항목을 추가해보세요.</div>`}
      </div>
      <div class="card"><h4>고정지출 분류별</h4>
        ${exp.map(([k, v]) => `<div class="bar"><div class="t"><span>${esc(k)}</span><b>${fmt(v)}</b></div><div class="track"><div class="fill" style="width:${(v / maxExp) * 100}%"></div></div></div>`).join("") || `<div class="empty">고정 탭에서 항목을 추가해보세요.</div>`}
      </div>`;
  },

  assets(c) {
    return `<div class="stats">
        ${stat("순자산", fmt(c.net))}
        ${stat("주식", fmt(c.investTotal + c.cash), { sub: "주식 탭 합계" })}
      </div>
      <div class="card"><h4><span><span class="dot" style="background:${CAT_COLORS["부동산"]}"></span>부동산</span><span class="sum">${fmt(c.reValue)}</span></h4>
        ${c.re.map((p, i) => reCard(p, i)).join("") || `<div class="empty">분양가·대출 조건·주변 시세를 넣으면 손익과 본전 시세를 계산해요.</div>`}
        <button class="add" data-add="realestate" data-prefill="{}">+ 추가</button>
      </div>` +
      section("전세 보증금", c.jeonse, c.loans.filter((l) => l.deposit).map((l) => rowLi("loans", db.loans[c.loans.indexOf(l)], l.name,
        [`대출 ${fmt(l.remain)}`, `내 돈 ${fmt(l.deposit - l.remain)}`, l.leaseEnd && `만기 ${l.leaseEnd.replaceAll("-", ".")}`].filter(Boolean).join(" · "), fmt(l.deposit))), "loans", { kind: "전세대출", method: "만기일시" }, CAT_COLORS["전세 보증금"]) +
      assetSection("예금·적금") +
      section("대출", c.debt, c.loans.map((l) => loanLi(l, c)), "loans", { kind: "주택담보대출", method: "원리금균등" }, "var(--muted)") +
      assetSection("기타");
  },

  expenses(c) {
    const kindBlock = (kind) => {
      const rows = db.expenses.filter((e) => (kind === "수입") === isIncome(e));
      // 대출 상환은 대출 탭 조건으로 자동 계산 (누르면 대출 편집)
      const loanCard = kind === "지출" && c.loans.length
        ? section("대출 상환", c.loanPayTotal, c.loans.map((l) => rowLi("loans", db.loans[c.loans.indexOf(l)], l.name,
            [dayLabel(l.payDay), l.account, l.rate ? `${l.rate}% ${l.method}` : "금리 미입력", "자동 계산"].filter(Boolean).join(" · "), fmt(l.pmt))), "loans", { method: "원리금균등" })
        : "";
      // 보유세: 부동산 탭 값으로 자동 추정, 연 금액 ÷ 12 (누르면 부동산 편집)
      const taxCard = kind === "지출" && c.taxMonthly
        ? section("보유세 (월 환산)", c.taxMonthly, c.re.filter((p) => p.hold.total).map((p) => rowLi("realestate", db.realestate[c.re.indexOf(p)], p.name,
            [`연 ${fmt(p.hold.total)}`, `재산세 7·9월${p.hold.compAll ? " · 종부세 12월" : ""}`, p.hold.estimated ? "공시가 추정" : "", "자동 계산"].filter(Boolean).join(" · "), fmt(p.hold.total / 12))), "realestate", {})
        : "";
      return `<div class="kind">고정${kind}</div>` + loanCard + taxCard +
        Object.entries(groupBy(rows, "category")).map(([cat, rs]) =>
          section(cat, sum(rs, (r) => r.amount), rs.map((r) => rowLi("expenses", r, r.name,
            [dayLabel(r.payDay), r.company, r.method, r.memo].filter(Boolean).join(" · "),
            fmt(r.amount), kind === "수입" ? "inc" : "")), "expenses", { kind, category: cat })
        ).join("") +
        `<button class="add solid" data-add="expenses" data-prefill='${esc(JSON.stringify({ kind }))}'>+ 고정${kind} 새 분류로 추가</button>`;
    };
    return `<div class="stats">
        ${stat("월 고정수입", fmt(c.fixedIn), { cls: "inc" })}
        ${stat("월 고정지출", fmt(c.fixedOut))}
        ${stat("월 여유자금", fmt(c.fixedIn - c.fixedOut), { wide: true, cls: c.fixedIn - c.fixedOut < 0 ? "up" : "" })}
      </div>
      ${c.upcoming.length ? `<details class="card fold"><summary><span>이번 달 남은 출금 <small class="muted">${c.upcoming.length}건 · 다음 ${dayLabel(c.upcoming[0].payDay)}</small></span><span class="sum">${fmt(sum(c.upcoming, (e) => e.amount))}</span></summary>
        <ul class="rows">${c.upcoming.map((u) => rowLi(u.src, u.ref, u.name, dayLabel(u.payDay), fmt(u.amount))).join("")}</ul></details>` : ""}
      ${kindBlock("수입")}${kindBlock("지출")}`;
  },

  invest(c) {
    const groups = groupBy(c.inv, "type");
    const fxCard = mode === "google"
      ? `<div class="stat wide"><div class="l">달러 환율 · 구글 파이낸스</div><div class="v">${fxLabel(db.fx)}</div>
          <button class="refresh" id="refreshBtn">시세 새로고침</button><div class="s">티커를 넣은 종목은 현재가가 자동으로 바뀌어요 (최대 20분 지연)</div></div>`
      : stat("달러 환율", fxLabel(db.fx), { wide: true, sub: "ECB 기준 · 매일 갱신" });
    const cashRows = db.assets.filter((a) => a.category === "증권사 예수금");
    return `<div class="stats">
        ${stat("총 평가금액", fmt(c.investTotal), { sub: `예수금 ${fmt(c.cash)} 별도` })}
        ${stat("평가 손익", sign(c.investGain), { cls: updown(c.investGain) })}
        ${fxCard}
      </div>` +
      section("예수금", c.cash, cashRows.map((r) => rowLi("assets", r, r.name, r.memo, fmt(r.amount))), "assets", { category: "증권사 예수금" }) +
      Object.entries(groups).map(([g, rows]) =>
        section(g, sum(rows, (r) => r.evalAmt), rows.map((r) =>
          rowLi("invest", db.invest[c.inv.indexOf(r)], r.name,
            `${r.qty}주 · ${r.foreign ? "$" : ""}${r.curPrice.toLocaleString()}${r.ticker && mode === "google" ? " · 자동" : ""}`,
            `${fmt(r.evalAmt)}<div class="small ${updown(r.gain)}">${sign(r.gain)} (${pct(r.rate)})</div>`)
        ), "invest", { type: g })
      ).join("") +
      `<button class="add solid" data-add="invest" data-prefill="{}">+ 새 구분으로 추가</button>`;
  },

};

function render() {
  $("#main").innerHTML = views[tab](calc());
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
}

/* ---------- 편집 다이얼로그 ---------- */
let editing = null; // { sheet, i }

function openEditor(sheet, i, prefill = {}) {
  editing = { sheet, i };
  $("#editor").returnValue = ""; // Esc로 닫을 때 이전 "ok"가 남아 저장되는 것 방지
  const isNew = i < 0;
  const obj = isNew ? prefill : db[sheet][i];
  const kind = sheet === "loans" ? loanKind(obj) : null;
  const { title, fields } = SHEETS[sheet];
  $("#editTitle").textContent = `${title} ${isNew ? "추가" : "수정"}`;
  $("#delBtn").hidden = isNew;
  $("#editFields").innerHTML = fields.filter((f) => !f.auto).map((f) => {
    const v = f.k === "kind" && kind ? kind : obj[f.k] ?? "";
    const hint = obj._f?.[f.k] && !(sheet === "invest" && f.k === "curPrice") ? "시트 수식 · 값을 바꾸면 수식이 지워져요" : f.hint;
    if (f.t === "loans") {
      const picked = names(v);
      return `<div class="f">${f.l} <span class="muted">(금리·기간 등은 대출 탭 값을 그대로 써요)</span>
        ${db.loans.map((l) => `<label class="pick"><input type="checkbox" name="loans" value="${esc(l.name)}" ${picked.includes(l.name) ? "checked" : ""}><span class="grow">${esc(l.name)}<br><small class="muted">${[l.rate && `${l.rate}%`, l.years && `${l.years}년`, l.method].filter(Boolean).join(" · ") || "금리·기간 미입력"}</small></span><span class="muted">잔여 ${fmt(l.remain)}</span></label>`).join("")
          || `<div class="muted small">자산 탭 → 대출에서 먼저 등록해주세요</div>`}</div>`;
    }
    if (f.t === "check") return `<label class="f check"><input type="checkbox" name="${f.k}" ${v ? "checked" : ""}> ${f.l}</label>`;
    if (f.t === "select") return `<label class="f">${f.l}<select name="${f.k}">${f.o.map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
    const opts = f.t === "list" ? [...new Set([...(f.o || []), ...db[sheet].map((r) => r[f.k]).filter(Boolean)])] : null;
    const type = f.t === "number" ? `type="text" inputmode="decimal" data-num autocomplete="off"`
      : f.t === "day" ? `type="number" inputmode="numeric" min="1" max="31"`
      : f.t === "date" ? `type="date"` : `type="text"`;
    return `<label class="f">${f.l}${hint ? ` <span class="muted">(${hint})</span>` : ""}
      <input name="${f.k}" ${type} value="${esc(f.t === "day" && !v ? "" : f.t === "number" ? withCommas(v) : v)}" ${opts ? `list="dl-${f.k}"` : ""} ${f.k === "name" ? "required" : ""}>
      ${opts ? `<datalist id="dl-${f.k}">${opts.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>` : ""}</label>`;
  }).join("") + (sheet === "loans" ? homePicker(obj) : "");
  // 대출 종류에 맞는 칸만 보이게
  fields.forEach((f) => f.only && $(`#editFields [name=${f.k}]`).closest(".f").setAttribute("data-only", f.only));
  showKind();
  $("#editor").showModal();
}

// 주담대: 담보 부동산을 여기서 바로 연결 (부동산 탭의 "연결 대출"과 같은 데이터)
const homePicker = (l) => `<div class="f" data-only="주택담보대출">담보 부동산 <span class="muted">(선택)</span>
  ${db.realestate.map((p) => `<label class="pick"><input type="checkbox" name="_home" value="${esc(p.name)}" ${l.name && names(p.loans).includes(l.name) ? "checked" : ""}><span class="grow">${esc(p.name)}</span><span class="muted">시세 ${fmt(p.curPrice)}</span></label>`).join("")
    || `<div class="muted small">자산 탭 → 부동산에서 등록하면 연결할 수 있어요</div>`}</div>`;
function showKind() {
  const k = $("#editFields [name=kind]");
  if (k && editing?.sheet === "loans") $("#editFields").querySelectorAll("[data-only]").forEach((el) => (el.hidden = el.dataset.only !== k.value));
}
$("#editFields").addEventListener("change", (e) => {
  if (e.target.name !== "kind" || editing?.sheet !== "loans") return;
  showKind();
  if (editing.i < 0) $("#editFields [name=method]").value = e.target.value === "전세대출" ? "만기일시" : "원리금균등"; // 새 대출만 흔한 방식으로
});

$("#editor").addEventListener("close", () => {
  if ($("#editor").returnValue !== "ok" || !editing) return;
  const { sheet, i } = editing;
  const old = i < 0 ? null : db[sheet][i];
  const fd = new FormData($("#editForm"));
  const obj = Object.fromEntries(SHEETS[sheet].fields.map((f) => [f.k,
    f.auto ? old?.[f.k] ?? ""
    : f.t === "check" ? fd.has(f.k)
    : f.t === "number" ? num(fd.get(f.k))
    : f.t === "day" ? Math.min(31, Math.max(0, parseInt(fd.get(f.k)) || 0))
    : f.t === "loans" ? fd.getAll(f.k).join(", ")
    : String(fd.get(f.k) ?? "").trim()]));
  if (sheet === "realestate" && old && obj.curPrice !== old.curPrice) obj.priceNote = ""; // 시세를 손으로 고치면 실거래가 근거는 지움
  // 다른 종류에서만 쓰는 칸은 비움 (예: 주담대로 바꾸면 전세 보증금 0)
  SHEETS[sheet].fields.forEach((f) => { if (f.only && f.only !== obj.kind) obj[f.k] = f.t === "number" ? 0 : ""; });
  // 값을 안 바꾼 칸의 시트 수식은 유지 (현재가 시세 수식은 티커로 다시 만듦)
  for (const k in old?._f || {}) {
    if (obj[k] === old[k] && !(sheet === "invest" && k === "curPrice")) (obj._f ||= {})[k] = old._f[k];
  }
  // 대출 이름을 바꾸면 부동산 연결도 같이 바꿈
  if (sheet === "loans" && old && old.name !== obj.name) {
    db.realestate.forEach((p) => (p.loans = names(p.loans).map((n) => (n === old.name ? obj.name : n)).join(", ")));
  }
  // 주담대의 담보 부동산 체크 → 부동산 "연결 대출" 갱신
  if (sheet === "loans" && obj.kind === "주택담보대출") {
    const homes = fd.getAll("_home");
    db.realestate.forEach((p) => {
      const rest = names(p.loans).filter((n) => n !== obj.name);
      p.loans = (homes.includes(p.name) ? [...rest, obj.name] : rest).join(", ");
    });
  }
  if (i < 0) db[sheet].push(obj); else db[sheet][i] = obj;
  editing = null;
  changed();
});

// 숫자 입력 중 쉼표 넣기 (커서 위치 유지)
$("#editFields").addEventListener("input", (e) => {
  const el = e.target;
  if (!("num" in el.dataset)) return;
  const keep = el.value.slice(0, el.selectionStart).replace(/[^\d.-]/g, "").length;
  el.value = withCommas(el.value);
  let i = 0;
  for (let n = 0; i < el.value.length && n < keep; i++) if (/[\d.-]/.test(el.value[i])) n++;
  el.setSelectionRange(i, i);
});

$("#delBtn").addEventListener("click", () => {
  if (!editing || !confirm("이 항목을 삭제할까요?")) return;
  db[editing.sheet].splice(editing.i, 1);
  editing = null;
  $("#editor").close();
  changed();
});

/* ---------- 이벤트 ---------- */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  render();
  scrollTo(0, 0);
});

$("#main").addEventListener("click", (e) => {
  if (e.target.id === "refreshBtn") return syncNow();
  const rp = e.target.closest("[data-reprice]");
  if (rp) return reprice(+rp.dataset.reprice);
  const li = e.target.closest("[data-sheet]");
  if (li) return openEditor(li.dataset.sheet, +li.dataset.i);
  const add = e.target.closest("[data-add]");
  if (add) return openEditor(add.dataset.add, -1, JSON.parse(add.dataset.prefill || "{}"));
});

// 지금 동기화: 시트 내용을 불러옴. 앱에 아직 못 올린 변경이 있을 때만 먼저 올림 (시트 직접 수정을 덮지 않게)
async function syncNow() {
  if (mode !== "google") return;
  if (!tokenOk()) return login();
  if (!sheetId) return connect();
  try { await (dirty ? push() : pull()); }
  catch (e) { if (e.message !== "login") { console.error(e); setStatus("동기화 실패", true); } }
}

// 토큰이 지났으면 아무 곳이나 처음 누를 때 다시 받음 (구글 창은 사용자 터치 안에서만 열 수 있음)
addEventListener("click", (e) => {
  if (mode !== "google" || tokenOk() || !auto || e.target.closest("#reconnect, #loginBtn, #pullBtn, #pushBtn")) return;
  auto = false;
  login();
}, true);
$("#loginBtn").onclick = login;
$("#reconnect").onclick = login;
$("#localBtn").onclick = () => {
  mode = "local"; ls.set("mode", mode);
  $("#welcome").close();
  changed(); loadFx();
};

$("#menuBtn").onclick = () => {
  const g = mode === "google";
  $("#openSheet").hidden = !(g && sheetId);
  if (sheetId) $("#openSheet").href = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  $("#menu").showModal();
};
// 불러오기: 시트 → 앱 (앱 데이터를 시트 내용으로 바꿈) / 저장하기: 앱 → 시트 (시트를 앱 데이터로 덮어씀)
// 로그인이 필요하면 로그인 뒤 connect()가 dirty를 보고 저장·불러오기를 고름
async function sheetSync(save) {
  $("#menu").close();
  const hasData = AI_SHEETS.some((k) => db[k].length);
  if (save && !confirm("구글 시트의 내용을 지금 앱의 데이터로 덮어쓸까요?")) return;
  if (!save && (dirty || mode !== "google") && hasData && !confirm("앱의 데이터를 구글 시트 내용으로 바꿀까요? (시트에 저장하지 않은 변경은 사라져요)")) return;
  gen++;
  dirty = save; ls.set("dirty", save);
  if (!tokenOk()) return login();
  if (!sheetId) return connect();
  try { await (save ? push() : pull()); }
  catch (e) { if (e.message !== "login") { console.error(e); setStatus(save ? "저장 실패" : "불러오기 실패", true); } }
}
$("#pullBtn").onclick = () => sheetSync(false);
$("#pushBtn").onclick = () => sheetSync(true);
/* ---------- AI로 데이터 가져오기 ---------- */
// 친구가 자산 화면 캡처 + 이 안내문을 AI에게 주면, AI가 아래 형식의 JSON을 만들어 줌 → 앱에 붙여넣기
const AI_SHEETS = ["assets", "loans", "expenses", "realestate", "invest"];
const AI_EXAMPLE = {
  assets: [{ category: "예금·적금", name: "KB국민은행 입출금", amount: 1250000, memo: "" }, { category: "증권사 예수금", name: "키움증권 예수금", amount: 350000, memo: "" }],
  loans: [{ kind: "주택담보대출", name: "우리은행 주담대", deposit: 0, leaseEnd: "", total: 200000000, remain: 185000000, rate: 4.2, years: 30, method: "원리금균등", start: "2023-03-15", payDay: 27, account: "우리은행", memo: "" }],
  expenses: [
    { kind: "지출", category: "보험", name: "실비보험", company: "KB손보", payDay: 25, amount: 19449, method: "국민은행", memo: "" },
    { kind: "수입", category: "급여", name: "월급", company: "", payDay: 25, amount: 3500000, method: "", memo: "" },
  ],
  realestate: [{ name: "우리집", address: "서울 마포구 상암동 1600 상암월드컵파크", unit: "101동 1203호", area: 84.97, buyPrice: 450000000, cost: 3000000, buyDate: "2023-03-15", homes: 1, adjusted: false, curPrice: 520000000, publicPrice: 0, loans: "우리은행 주담대", memo: "", priceNote: "" }],
  invest: [
    { type: "해외주식", name: "애플", ticker: "NASDAQ:AAPL", foreign: true, buyPrice: 114.3, curPrice: 333.6, qty: 28 },
    { type: "ISA", name: "TIGER 미국S&P500", ticker: "KRX:360750", foreign: false, buyPrice: 21125, curPrice: 26025, qty: 100 },
  ],
};
const typeDoc = (f) => ({
  number: "숫자 (쉼표·단위 없이)", day: "숫자 1~31 (말일=31, 없으면 0)", check: "true 또는 false",
  date: "\"YYYY-MM-DD\" (모르면 \"\")", select: (f.o || []).map((o) => `"${o}"`).join(" | "),
}[f.t] || "문자열");

function aiPrompt() {
  return `첨부한 스크린샷(은행·증권·대출·보험 앱 화면 등)을 보고 "자산관리" 앱에 넣을 JSON을 만들어줘.

[규칙]
- 결과는 JSON 하나만 출력 (설명 없이 코드블록 하나)
- 숫자는 쉼표·"원"·"%"·"주" 없이 숫자만. 금액은 원 단위 (대출 금액도 양수), 해외 주식 가격만 달러
- 스크린샷에 없는 값은 지어내지 말고 숫자는 0, 글자는 ""
- 해당되는 항목(키)만 넣어도 됨. 앱의 기존 데이터는 지워지지 않고, 이름이 같은 항목은 새 값으로 고쳐짐
- 키 이름과 선택지 값은 아래 정의와 글자까지 똑같이

[형식] 최상위는 객체, 각 키는 배열
${AI_SHEETS.map((k) => `
■ ${k} — ${SHEETS[k].desc}
${SHEETS[k].fields.map((f) => `- ${f.k} (${f.l}): ${typeDoc(f)}${f.ai || f.hint ? " — " + (f.ai || f.hint) : ""}`).join("\n")}`).join("\n")}

[예시]
{
${Object.entries(AI_EXAMPLE).map(([k, rows]) => `  "${k}": [\n${rows.map((o) => "    " + JSON.stringify(o)).join(",\n")}\n  ]`).join(",\n")}
}`;
}

// AI 답변 → 앱 데이터. 코드블록·앞뒤 설명이 섞여 있어도 { … } 부분만 읽고, 값은 앱 형식으로 정리
const toNum = (v) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0);
const normalize = (k, o) => Object.fromEntries(SHEETS[k].fields.map((f) => {
  const v = o?.[f.k];
  if (f.t === "number") return [f.k, k === "loans" ? Math.abs(toNum(v)) : toNum(v)];
  if (f.t === "day") return [f.k, Math.min(31, Math.max(0, parseDay(v ?? 0)))];
  if (f.t === "check") return [f.k, v === true || /^(y|yes|true|o|1)$/i.test(String(v ?? "").trim())];
  if (f.t === "select") return [f.k, f.o.includes(v) || (k === "assets" && v === "대출") ? v : f.k === "category" ? "기타" : k === "loans" && f.k === "kind" ? "" : f.o[0]]; // 대출 종류를 모르면 비워두고 loanKind()가 추정 // 자산에 들어온 "대출"은 migrate()가 대출 탭으로 옮김
  if (f.t === "date") return [f.k, /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""];
  if (f.t === "loans") return [f.k, Array.isArray(v) ? v.join(", ") : String(v ?? "")];
  return [f.k, String(v ?? "").trim()];
}));
function parseImport(textIn) {
  const s = String(textIn), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("JSON을 찾지 못했어요");
  const data = JSON.parse(s.slice(a, b + 1));
  const out = {}, raw = {}; // raw: AI가 실제로 준 칸을 알기 위해 원본도 같은 순서로 보관
  for (const k of AI_SHEETS) if (Array.isArray(data[k])) {
    raw[k] = data[k].filter((o) => o && typeof o === "object");
    out[k] = raw[k].map((o) => normalize(k, o));
    raw[k] = raw[k].filter((_, i) => out[k][i].name);
    out[k] = out[k].filter((o) => o.name);
  }
  if (!Object.keys(out).length) throw new Error(`${AI_SHEETS.join(", ")} 중 하나는 있어야 해요`);
  return Object.defineProperty(out, "raw", { value: raw }); // 숨은 속성: 결과 모양(키 = 탭)은 그대로
}
// 기존 데이터는 지우지 않음: 같은 이름(주식은 같은 계좌 구분 + 이름)이 있으면 그 항목을 고치고, 없으면 뒤에 추가
// 고칠 때는 AI가 값을 준 칸만 바꿈 ("", 0은 "모름"이라 기존 값 유지)
// ponytail: 티커로는 안 찾음 — 같은 종목을 여러 계좌·사람이 갖고 있을 수 있음
const sameRow = (k, a, b) => a.name.trim() === b.name.trim() && (k !== "invest" || a.type.trim() === b.type.trim());
function applyImport(data, raw) {
  const count = { add: 0, update: 0 };
  for (const k in data) data[k].forEach((o, i) => {
    const old = db[k].find((r) => sameRow(k, r, o));
    if (!old) { db[k].push(o); count.add++; return; }
    SHEETS[k].fields.forEach((f) => {
      const v = o[f.k];
      if (f.t === "select" && raw[k][i][f.k] !== v) return; // 선택지에 없는 값을 "기타" 등으로 바꾼 거면 기존 값 유지
      if (f.k in raw[k][i] && v !== "" && v !== 0) { old[f.k] = v; if (old._f) delete old._f[f.k]; } // 시트 수식보다 새 값이 이김
    });
    count.update++;
  });
  migrate();
  changed();
  setStatus(`가져오기: 추가 ${count.add}건 · 수정 ${count.update}건`);
}

let pending = null;
$("#keyBtn").onclick = () => { $("#menu").close(); askKey(); };
$("#importBtn").onclick = () => {
  $("#menu").close();
  $("#importText").value = ""; $("#importInfo").textContent = ""; pending = null;
  $("#importApply").disabled = true;
  $("#importDlg").returnValue = "";
  $("#importDlg").showModal();
};
$("#copyPrompt").onclick = async () => {
  const t = aiPrompt();
  try { await navigator.clipboard.writeText(t); }
  catch { const ta = Object.assign(document.createElement("textarea"), { value: t }); document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  $("#copyPrompt").textContent = "복사됐어요 ✓ AI에게 붙여넣으세요";
  setTimeout(() => ($("#copyPrompt").textContent = "AI 안내문 복사"), 3000);
};
$("#importText").oninput = () => {
  try {
    pending = parseImport($("#importText").value);
    $("#importInfo").textContent = Object.entries(pending).map(([k, rows]) => {
      const upd = rows.filter((o) => db[k].some((r) => sameRow(k, r, o))).length;
      return `${SHEETS[k].title} 추가 ${rows.length - upd}건${upd ? `·수정 ${upd}건` : ""}`;
    }).join(" · ") + " — 기존 데이터는 지우지 않고, 같은 이름은 새 값으로 고쳐요";
    $("#importInfo").className = "small";
  } catch (e) {
    pending = null;
    $("#importInfo").textContent = $("#importText").value.trim() ? "읽을 수 없어요: " + e.message : "";
    $("#importInfo").className = "small err";
  }
  $("#importApply").disabled = !pending;
};
$("#importDlg").addEventListener("close", () => {
  if (pending && $("#importDlg").returnValue === "merge") applyImport(pending, pending.raw);
  pending = null;
});

$("#logoutBtn").onclick = () => {
  if (!confirm("이 기기의 데이터와 로그인 정보를 지울까요? (구글 시트의 데이터는 그대로 남아요)")) return;
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.v);
  ["db", "mode", "dirty", "token"].forEach(ls.del);
  location.reload();
};

// 앱으로 돌아오면(탭 전환·창 포커스) 못 올린 건 올리고, 아니면 시트·다른 기기의 변경을 가져옴
let lastPull = 0;
function comeBack() {
  if (mode !== "google") return;
  if (dirty) return flush();
  if (!tokenOk()) return void needLogin();
  if (!sheetId || $("#editor").open || Date.now() - lastPull < 5000) return; // 편집 중엔 안 바꿈
  lastPull = Date.now();
  pull().catch(() => {});
}
document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? mode === "google" && flush() : comeBack()));
addEventListener("focus", comeBack);
addEventListener("online", flush);

/* ---------- 시작 ---------- */
if (migrate()) { ls.set("db", db); if (mode === "google") { dirty = true; ls.set("dirty", true); } }
render();
if (!mode) $("#welcome").showModal();
else if (mode === "local") { changed(); loadFx(); }
else if (tokenOk()) connect();
else needLogin();

addEventListener("load", initAuth);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
