import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
    collection, getDocs, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// =========================================================================
// 1. Firebase 설정 (실제 프로젝트 키 적용 완료)[cite: 1]
// =========================================================================
const firebaseConfig = {
    apiKey: "AIzaSyBavQoBaevqOh6AXcrQ6DXhgByoXWhQCAw",
    authDomain: "meetcount-9761b.firebaseapp.com",
    projectId: "meetcount-9761b",
    storageBucket: "meetcount-9761b.firebasestorage.app",
    messagingSenderId: "778322578759",
    appId: "1:778322578759:web:6b512f64d327460c9e1062",
    measurementId: "G-FXBE8TE45N"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// =========================================================================
// 2. 보안 유틸리티: SHA-256 해시 변환 함수
// =========================================================================
async function sha256(str) {
    const buf = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// =========================================================================
// 3. 전역 상태 관리
// =========================================================================
const state = {
    role: "easy",            // 'easy' | 'hybrid' | 'master'
    pinInput: "",
    authHashes: { userPinHash: "", masterPinHash: "" },
    currentMonth: "",        // 'YYYY-MM'
    currentSessionId: "",    // 'YYYY-MM-DD-weekday' | 'YYYY-MM-DD-weekend'
    monthPool: { publisherCount: 100 },
    sessionData: null,
    allMonthSessionsMap: {},
    unsubPool: null,
    unsubSession: null,
    unsubMonthAll: null
};

const SUBTYPE_LABELS = {
    normal: "정상",
    circuit: "순회주간(화)",
    memorial: "기념식",
    none: "집회없음"
};

const HELP_CONTENTS = {
    total: "대면 참석자와 비대면 참석자의 숫자를 모두 합산한 이번 집회 총 참석 인원입니다.",
    inperson: "연단, 좌·중·우 청중석, 확성부, 청중마이크, 안내부, 장로회의실에 참석한 현장 총인원입니다.",
    online: "화면(가구)별 또는 직접 입력으로 집계된 비대면 참석 총인원입니다.",
    temp: "순회감독자, 전파자학교 학생, 공개강연 연사, 특별방문자 등 실질 참석률 계산 시 차감되는 임시 방문 인원입니다.",
    "easy-inperson": "쉬운 모드에서 대면 참석 총인원을 직접 입력하거나 (-) (+) 버튼으로 간편하게 조절합니다.",
    "easy-online": "쉬운 모드에서 비대면 참석 총인원을 직접 입력하거나 (-) (+) 버튼으로 간편하게 조절합니다."
};

// 기본 빈 회차 데이터 생성기
function createDefaultSessionDoc(meta) {
    return {
        id: meta.id,
        category: meta.category,
        defaultDate: meta.defaultDate,
        actualDate: meta.defaultDate,
        subType: "normal",
        note: "",
        inPerson: {
            platform: 0,
            seatLeft: 0,
            seatCenter: 0,
            seatRight: 0,
            soundBooth: 0,
            rearAttendant: 0,
            eldersRoom: 0,
            eldersRoomChecked: false,
            outdoor: 0
        },
        online: {
            devices: 0,
            total: 0
        },
        temp: {
            circuitOverseer: 0,
            skeStudents: 0,
            publicSpeaker: 0,
            specialVisitors: 0,
            specialNote: ""
        }
    };
}

// =========================================================================
// 4. 초기화 및 인증
// =========================================================================
async function initApp() {
    try {
        await signInAnonymously(auth);
    } catch (e) {
        console.info("익명 로그인 미설정 상태:", e.code);
    }

    const defaultUserHash = await sha256("0000");
    const defaultMasterHash = await sha256("1935");
    state.authHashes = { userPinHash: defaultUserHash, masterPinHash: defaultMasterHash };

    try {
        const authRef = doc(db, "settings", "auth");
        const snap = await getDoc(authRef);
        if (snap.exists()) {
            const data = snap.data();
            state.authHashes.userPinHash = data.userPinHash || defaultUserHash;
            state.authHashes.masterPinHash = data.masterPinHash || defaultMasterHash;
        } else {
            await setDoc(authRef, {
                userPinHash: defaultUserHash,
                masterPinHash: defaultMasterHash,
                updatedAt: new Date().toISOString()
            });
        }
    } catch (err) {
        console.warn("인증 설정 조회 오류:", err);
    }

    initMonthDropdown();
    switchToEasyMode();
}

// =========================================================================
// 5. 날짜 및 일정 계산기 (KST 기준)
// =========================================================================
function formatLocalYYYYMMDD(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function getDayOfWeekKor(dateStr) {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    const [y, m, d] = dateStr.split('-').map(Number);
    return days[new Date(y, m - 1, d).getDay()];
}

function generateMonthSchedule(ym) {
    const [y, m] = ym.split('-').map(Number);
    const list = [];
    const daysInMonth = new Date(y, m, 0).getDate();

    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(y, m - 1, d);
        const dow = dt.getDay();
        const dateStr = formatLocalYYYYMMDD(y, m, d);
        if (dow === 4) {
            list.push({ id: `${dateStr}-weekday`, category: "weekday", defaultDate: dateStr });
        } else if (dow === 0) {
            list.push({ id: `${dateStr}-weekend`, category: "weekend", defaultDate: dateStr });
        }
    }
    return list;
}

function initMonthDropdown() {
    const sel = document.getElementById("month-selector");
    sel.innerHTML = "";
    const now = new Date();
    for (let offset = -3; offset <= 4; offset++) {
        const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const opt = document.createElement("option");
        opt.value = ym;
        opt.innerText = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
        sel.appendChild(opt);
    }
    const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    sel.value = curYM;
    state.currentMonth = curYM;
}

function onMonthChange() {
    state.currentMonth = document.getElementById("month-selector").value;
    subscribeMonthData(state.currentMonth);
}

function onSessionChange() {
    state.currentSessionId = document.getElementById("session-selector").value;
    subscribeSingleSession(state.currentMonth, state.currentSessionId);
}

// =========================================================================
// 6. Firestore 실시간 구독
// =========================================================================
async function subscribeMonthData(ym) {
    if (state.unsubPool) state.unsubPool();
    if (state.unsubMonthAll) state.unsubMonthAll();

    const monthRef = doc(db, "months", ym);
    try {
        const snap = await getDoc(monthRef);
        if (!snap.exists()) {
            await setDoc(monthRef, { publisherCount: 100 }, { merge: true });
        }
    } catch (e) {
        console.warn("월간 모수 초기화 확인 오류:", e);
    }

    state.unsubPool = onSnapshot(monthRef, (docSnap) => {
        if (docSnap.exists()) {
            const d = docSnap.data();
            state.monthPool = { publisherCount: Number(d.publisherCount ?? 100) };
            document.getElementById("dash-pub-count").innerText = state.monthPool.publisherCount;
            renderDashboardAndStats();
        }
    });

    const baseSchedule = generateMonthSchedule(ym);
    const sessionsColRef = collection(db, "months", ym, "sessions");

    state.unsubMonthAll = onSnapshot(sessionsColRef, (querySnap) => {
        const map = {};
        querySnap.forEach(sDoc => { map[sDoc.id] = sDoc.data(); });
        state.allMonthSessionsMap = map;
        populateSessionDropdown(baseSchedule, map);
        renderMonthlyTables();
    });

    const todayStr = formatLocalYYYYMMDD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    let chosen = baseSchedule.find(s => s.defaultDate >= todayStr) || baseSchedule[baseSchedule.length - 1];
    state.currentSessionId = chosen.id;
    subscribeSingleSession(ym, state.currentSessionId);
}

function populateSessionDropdown(baseSchedule, map) {
    const sel = document.getElementById("session-selector");
    sel.innerHTML = "";
    baseSchedule.forEach(item => {
        const saved = map[item.id];
        const actualDate = (saved && saved.actualDate) ? saved.actualDate : item.defaultDate;
        const dow = getDayOfWeekKor(actualDate);
        const catName = item.category === "weekday" ? "평일" : "주말";
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.innerText = `${actualDate.slice(5)} (${dow}) ${catName}`;
        sel.appendChild(opt);
    });
    if (state.currentSessionId) sel.value = state.currentSessionId;
}

function subscribeSingleSession(ym, sessionId) {
    if (state.unsubSession) state.unsubSession();

    const baseSchedule = generateMonthSchedule(ym);
    const meta = baseSchedule.find(s => s.id === sessionId) || {
        id: sessionId,
        category: sessionId.includes("weekday") ? "weekday" : "weekend",
        defaultDate: sessionId.slice(0, 10)
    };

    const sessionRef = doc(db, "months", ym, "sessions", sessionId);
    state.unsubSession = onSnapshot(sessionRef, async (docSnap) => {
        if (!docSnap.exists()) {
            const defaultData = createDefaultSessionDoc(meta);
            try { await setDoc(sessionRef, defaultData); } catch (e) { console.error(e); }
            state.sessionData = defaultData;
        } else {
            state.sessionData = docSnap.data();
        }
        renderUI();
    });
}

// =========================================================================
// 7. 통계 산출 및 렌더링
// =========================================================================
function getInPersonSum(ip) {
    if (!ip) return 0;
    return (Number(ip.platform) || 0) +
           (Number(ip.seatLeft) || 0) +
           (Number(ip.seatCenter) || 0) +
           (Number(ip.seatRight) || 0) +
           (Number(ip.soundBooth) || 0) +
           (Number(ip.rearAttendant) || 0) +
           (Number(ip.eldersRoom) || 0) +
           (Number(ip.outdoor) || 0);
}

function getTempSum(tp) {
    if (!tp) return 0;
    return (Number(tp.circuitOverseer) || 0) +
           (Number(tp.skeStudents) || 0) +
           (Number(tp.publicSpeaker) || 0) +
           (Number(tp.specialVisitors) || 0);
}

function renderUI() {
    const d = state.sessionData;
    if (!d) return;

    const ipSum = getInPersonSum(d.inPerson);
    const onSum = Number(d.online?.total) || 0;
    const grandTotal = ipSum + onSum;
    const tempSum = getTempSum(d.temp);
    const pubCount = Number(state.monthPool.publisherCount) || 100;
    const generalRate = pubCount > 0 ? ((grandTotal / pubCount) * 100).toFixed(1) : "0.0";

    // 대시보드 반영
    document.getElementById("dash-grand-total").innerText = `${grandTotal}명`;
    document.getElementById("dash-inperson").innerText = `${ipSum}명`;
    document.getElementById("dash-online").innerText = `${onSum}명`;
    document.getElementById("dash-temp").innerText = `${tempSum}명`;
    document.getElementById("dash-general-rate").innerText = `${generalRate}%`;

    // 쉬운 모드 반영
    document.getElementById("easy-val-inperson").value = ipSum;
    document.getElementById("easy-val-online").value = onSum;
    document.getElementById("easy-grand-total").innerText = `${grandTotal}명`;

    // 상세 모드 구역별 반영
    const ip = d.inPerson || {};
    document.getElementById("val-platform").value = ip.platform || 0;
    document.getElementById("val-seatLeft").value = ip.seatLeft || 0;
    document.getElementById("val-seatCenter").value = ip.seatCenter || 0;
    document.getElementById("val-seatRight").value = ip.seatRight || 0;
    document.getElementById("val-soundBooth").value = ip.soundBooth || 0;
    document.getElementById("val-rearAttendant").value = ip.rearAttendant || 0;
    document.getElementById("val-outdoor").value = ip.outdoor || 0;
    document.getElementById("val-eldersRoom").value = ip.eldersRoom || 0;
    document.getElementById("check-eldersRoom").checked = !!ip.eldersRoomChecked;
    document.getElementById("label-inperson-sum").innerText = `대면 소계: ${ipSum}명`;

    document.getElementById("input-online-devices").value = d.online?.devices || 0;
    document.getElementById("input-online-total").value = onSum;
    document.getElementById("label-online-sum").innerText = `${onSum}명 (기기 ${d.online?.devices || 0}대)`;

    // 마스터 전용 임시참석자 반영
    const tp = d.temp || {};
    document.getElementById("val-circuitOverseer").innerText = tp.circuitOverseer || 0;
    document.getElementById("val-skeStudents").innerText = tp.skeStudents || 0;
    document.getElementById("val-publicSpeaker").innerText = tp.publicSpeaker || 0;
    document.getElementById("val-specialVisitors").innerText = tp.specialVisitors || 0;
    document.getElementById("input-specialNote").value = tp.specialNote || "";

    checkDateEditable();
}

function renderDashboardAndStats() {
    renderUI();
}

// =========================================================================
// 8. 권한 및 날짜 수정 제한 체크
// =========================================================================
function checkDateEditable() {
    const todayStr = formatLocalYYYYMMDD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    const sessionDate = state.sessionData?.actualDate || state.sessionData?.defaultDate || todayStr;
    const isToday = (sessionDate === todayStr);

    const isMaster = (state.role === "master");
    const isHybrid = (state.role === "hybrid");
    const isEasy = (state.role === "easy");

    // 쉬운 모드 및 하이브리드 모드는 오늘만 수정 가능 (마스터는 언제든 가능)
    const canEdit = isMaster || (isToday && (isEasy || isHybrid));

    // 입력창 제어
    const inputs = document.querySelectorAll("#view-easy input, #view-detailed input");
    inputs.forEach(inp => {
        if (!isMaster && !isToday && inp.id !== 'input-specialNote') {
            inp.disabled = true;
        } else if (isEasy && !isMaster) {
            inp.disabled = true; // 쉬운 모드는 기본적으로 잠겨있고 '수정 모드' 시 해제
        } else {
            inp.disabled = false;
        }
    });

    const notice = document.getElementById("easy-mode-notice");
    if (!isMaster && !isToday) {
        notice.innerText = "※ 오늘 날짜가 지난 예전 기록은 마스터 관리자만 수정할 수 있습니다.";
        notice.className = "text-[11px] text-rose-600 font-bold text-center mt-2";
    } else {
        notice.innerText = "※ 당일 내역은 언제든 저장·수정 가능합니다.";
        notice.className = "text-[11px] text-slate-400 text-center mt-2";
    }
}

function unlockEditMode() {
    const todayStr = formatLocalYYYYMMDD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    const sessionDate = state.sessionData?.actualDate || state.sessionData?.defaultDate || todayStr;
    const today = formatLocalYYYYMMDD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());

    if (sessionDate !== today) {
        alert("당일이 지난 예전 기록은 쉬운 모드로 수정할 수 없습니다.");
        return;
    }
    document.getElementById("easy-val-inperson").disabled = false;
    document.getElementById("easy-val-online").disabled = false;
    alert("쉬운 모드 수정이 활성화되었습니다. 숫자를 변경한 뒤 [당일 내역 저장]을 눌러주세요.");
}

// =========================================================================
// 9. 데이터 저장 및 카운터 조작 트랜잭션
// =========================================================================
async function saveEasySession() {
    const todayStr = formatLocalYYYYMMDD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    const sessionDate = state.sessionData?.actualDate || state.sessionData?.defaultDate || todayStr;
    const today = formatLocalYYYYMMDD(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());

    if (state.role !== "master" && sessionDate !== today) {
        alert("오늘 날짜가 지난 기록은 수정할 수 없습니다.");
        return;
    }

    const inPersonTotal = Math.max(0, parseInt(document.getElementById("easy-val-inperson").value, 10) || 0);
    const onlineTotal = Math.max(0, parseInt(document.getElementById("easy-val-online").value, 10) || 0);

    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const data = snap.data();
            // 쉬운 모드에서는 대면 총합을 대표 구역(예: seatCenter 등 혹은 합산)에 반영하거나 간편 필드로 저장
            // 여기서는 깔끔하게 seatCenter에 대면 총합을 몰아넣거나 기존 구역 합산을 맞춤
            tx.update(ref, {
                "inPerson.seatCenter": inPersonTotal,
                "inPerson.platform": 0,
                "inPerson.seatLeft": 0,
                "inPerson.seatRight": 0,
                "inPerson.soundBooth": 0,
                "inPerson.rearAttendant": 0,
                "inPerson.eldersRoom": 0,
                "inPerson.outdoor": 0,
                "online.total": onlineTotal,
                "online.devices": onlineTotal > 0 ? 1 : 0
            });
        });
        alert("당일 내역이 성공적으로 저장되었습니다!");
    } catch (err) {
        alert("저장 실패: " + err.message);
    }
}

function addEasyCount(field, delta) {
    const id = field === 'inperson' ? 'easy-val-inperson' : 'easy-val-online';
    const inp = document.getElementById(id);
    const cur = parseInt(inp.value, 10) || 0;
    inp.value = Math.max(0, cur + delta);
    // 실시간 총합 연동
    const ip = parseInt(document.getElementById("easy-val-inperson").value, 10) || 0;
    const on = parseInt(document.getElementById("easy-val-online").value, 10) || 0;
    document.getElementById("easy-grand-total").innerText = `${ip + on}명`;
}

function setEasyCountDirect(field, val) {
    const num = Math.max(0, parseInt(val, 10) || 0);
    const ip = field === 'inperson' ? num : (parseInt(document.getElementById("easy-val-inperson").value, 10) || 0);
    const on = field === 'online' ? num : (parseInt(document.getElementById("easy-val-online").value, 10) || 0);
    document.getElementById("easy-grand-total").innerText = `${ip + on}명`;
}

async function addZone(field, delta) {
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const data = snap.data();
            const cur = Number(data.inPerson?.[field]) || 0;
            const next = Math.max(0, cur + delta);
            tx.update(ref, { [`inPerson.${field}`]: next });
        });
    } catch (err) { console.error(err); }
}

async function setZoneDirect(field, val) {
    const num = Math.max(0, parseInt(val, 10) || 0);
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await updateDoc(ref, { [`inPerson.${field}`]: num });
    } catch (err) { console.error(err); }
}

async function toggleZoneCheck(field) {
    const checked = document.getElementById(`check-${field}`).checked;
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await updateDoc(ref, { [`inPerson.${field}Checked`]: checked });
    } catch (err) { console.error(err); }
}

async function saveDetailedSession() {
    alert("구역별 대면 내역이 실시간 동기화되었습니다!");
}

async function adjustOnlineDirect(field, delta) {
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const data = snap.data();
            const on = data.online || { devices: 0, total: 0 };
            on[field] = Math.max(0, (Number(on[field]) || 0) + delta);
            tx.update(ref, { online: on });
        });
    } catch (err) { console.error(err); }
}

async function saveOnlineDirect() {
    const devices = Math.max(0, parseInt(document.getElementById("input-online-devices").value, 10) || 0);
    const total = Math.max(0, parseInt(document.getElementById("input-online-total").value, 10) || 0);
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await updateDoc(ref, { "online.devices": devices, "online.total": total });
    } catch (err) { console.error(err); }
}

async function addTemp(field, delta) {
    if (state.role !== "master") {
        alert("당일 임시 참석자 입력은 마스터 관리자만 가능합니다.");
        return;
    }
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const data = snap.data();
            const tp = data.temp || {};
            tp[field] = Math.max(0, (Number(tp[field]) || 0) + delta);
            tx.update(ref, { temp: tp });
        });
    } catch (err) { console.error(err); }
}

async function saveTempNote() {
    if (state.role !== "master") return;
    const note = document.getElementById("input-specialNote").value.trim();
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await updateDoc(ref, { "temp.specialNote": note });
    } catch (err) { console.error(err); }
}

// =========================================================================
// 10. 월간 통계표 및 보고서
// =========================================================================
function renderMonthlyTables() {
    const baseSchedule = generateMonthSchedule(state.currentMonth);
    const weekdays = baseSchedule.filter(s => s.category === "weekday");
    const weekends = baseSchedule.filter(s => s.category === "weekend");

    renderCategoryTable("tbody-weekday", weekdays);
    renderCategoryTable("tbody-weekend", weekends);
}

function renderCategoryTable(tbodyId, scheduleItems) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    let html = "";
    scheduleItems.forEach((item, idx) => {
        const d = state.allMonthSessionsMap[item.id] || createDefaultSessionDoc(item);
        const actualDate = d.actualDate || item.defaultDate;
        const dow = getDayOfWeekKor(actualDate);
        const ip = getInPersonSum(d.inPerson);
        const on = Number(d.online?.total) || 0;
        const total = ip + on;

        html += `
            <tr class="border-b border-slate-100">
                <td class="p-2">${idx + 1}주 ${actualDate.slice(5)}(${dow})</td>
                <td class="p-2 text-right">${ip}</td>
                <td class="p-2 text-right">${on}</td>
                <td class="p-2 text-right font-bold text-blue-700">${total}</td>
            </tr>`;
    });
    tbody.innerHTML = html;
}

function copyCurrentReport() {
    if (!state.sessionData) return;
    const d = state.sessionData;
    const ip = getInPersonSum(d.inPerson);
    const on = Number(d.online?.total) || 0;
    const total = ip + on;
    const actualDate = d.actualDate || d.defaultDate;

    const report = `[MeetCount 집회 참석 보고]\n• 일시: ${actualDate} (${getDayOfWeekKor(actualDate)})\n• 대면 합계: ${ip}명\n• 비대면 합계: ${on}명\n• 총 참석자: ${total}명`;
    navigator.clipboard.writeText(report).then(() => {
        alert("보고서 텍스트가 복사되었습니다!");
    });
}

function exportMonthlyCSV() {
    const baseSchedule = generateMonthSchedule(state.currentMonth);
    let csv = "\uFEFF날짜,요일,구분,대면합계,비대면합계,총참석자\n";
    baseSchedule.forEach(item => {
        const d = state.allMonthSessionsMap[item.id] || createDefaultSessionDoc(item);
        const actualDate = d.actualDate || item.defaultDate;
        const dow = getDayOfWeekKor(actualDate);
        const cat = item.category === "weekday" ? "평일" : "주말";
        const ip = getInPersonSum(d.inPerson);
        const on = Number(d.online?.total) || 0;
        csv += `${actualDate},${dow},${cat},${ip},${on},${ip + on}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `MeetCount_${state.currentMonth}_통계.csv`;
    a.click();
}

// =========================================================================
// 11. 인증 및 모달 제어
// =========================================================================
function switchToEasyMode() {
    state.role = "easy";
    document.getElementById("view-easy").classList.remove("hidden");
    document.getElementById("view-detailed").classList.add("hidden");
    document.getElementById("logout-btn").classList.add("hidden");
    document.getElementById("master-btn").classList.add("hidden");
    document.getElementById("role-badge").innerText = "쉬운 모드 (암호 없음)";
    document.getElementById("role-badge").className = "text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-extrabold";
    document.getElementById("master-only-section").classList.add("hidden");
    checkDateEditable();
}

function openAuthModal() {
    state.pinInput = "";
    document.getElementById("pin-error").innerText = "";
    updatePinDisplay();
    document.getElementById("auth-screen").classList.remove("hidden");
}

function closeAuthModal() {
    document.getElementById("auth-screen").classList.add("hidden");
}

function pressPin(digit) {
    if (state.pinInput.length < 4) {
        state.pinInput += digit;
        updatePinDisplay();
        if (state.pinInput.length === 4) setTimeout(() => submitPin(), 120);
    }
}

function clearPin() {
    state.pinInput = "";
    document.getElementById("pin-error").innerText = "";
    updatePinDisplay();
}

function updatePinDisplay() {
    const filled = "●".repeat(state.pinInput.length);
    const empty = "•".repeat(4 - state.pinInput.length);
    document.getElementById("pin-display").innerText = filled + empty;
}

async function submitPin() {
    if (state.pinInput.length !== 4) return;
    const inputHash = await sha256(state.pinInput);

    if (inputHash === state.authHashes.masterPinHash) {
        enterMode("master");
    } else if (inputHash === state.authHashes.userPinHash) {
        enterMode("hybrid");
    } else {
        document.getElementById("pin-error").innerText = "암호가 올바르지 않습니다.";
        state.pinInput = "";
        updatePinDisplay();
    }
}

function enterMode(role) {
    state.role = role;
    closeAuthModal();
    document.getElementById("view-easy").classList.add("hidden");
    document.getElementById("view-detailed").classList.remove("hidden");
    document.getElementById("logout-btn").classList.remove("hidden");

    const badge = document.getElementById("role-badge");
    const masterBtn = document.getElementById("master-btn");
    const masterSection = document.getElementById("master-only-section");

    if (role === "master") {
        badge.innerText = "마스터 관리자 (1935)";
        badge.className = "text-[11px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-extrabold";
        masterBtn.classList.remove("hidden");
        masterSection.classList.remove("hidden");
        document.getElementById("detailed-title").innerText = "🏛️ [마스터] 대면 구역별 세부 카운터";
    } else {
        badge.innerText = "하이브리드 모드 (0000)";
        badge.className = "text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-extrabold";
        masterBtn.classList.add("hidden");
        masterSection.classList.add("hidden");
        document.getElementById("detailed-title").innerText = "🏛️ 대면 구역별 세부 카운터";
    }
    checkDateEditable();
}

function openMasterModal() {
    if (state.role !== "master") return;
    const d = state.sessionData || {};
    document.getElementById("master-subtype").value = d.subType || "normal";
    document.getElementById("master-custom-date").value = d.actualDate || d.defaultDate || "";
    document.getElementById("master-session-note").value = d.note || "";
    document.getElementById("master-pub-count").value = state.monthPool.publisherCount || 100;
    document.getElementById("master-modal").classList.remove("hidden");
}

function closeMasterModal() {
    document.getElementById("master-modal").classList.add("hidden");
}

async function saveMasterSessionConfig() {
    const subType = document.getElementById("master-subtype").value;
    const actualDate = document.getElementById("master-custom-date").value;
    const note = document.getElementById("master-session-note").value.trim();
    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await updateDoc(ref, { subType, actualDate, note });
        alert("회차 설정이 저장되었습니다.");
        closeMasterModal();
    } catch (err) { alert("오류: " + err.message); }
}

async function saveMasterPoolConfig() {
    const publisherCount = Math.max(1, parseInt(document.getElementById("master-pub-count").value, 10) || 100);
    const ref = doc(db, "months", state.currentMonth);
    try {
        await setDoc(ref, { publisherCount }, { merge: true });
        alert("기본 전도인 수가 저장되었습니다.");
        closeMasterModal();
    } catch (err) { alert("오류: " + err.message); }
}

function openMonthStatsModal() {
    const baseSchedule = generateMonthSchedule(state.currentMonth);
    let html = "";
    baseSchedule.forEach((item, idx) => {
        const d = state.allMonthSessionsMap[item.id] || createDefaultSessionDoc(item);
        const actualDate = d.actualDate || item.defaultDate;
        const ip = getInPersonSum(d.inPerson);
        const on = Number(d.online?.total) || 0;
        html += `<div class="bg-slate-50 p-2.5 rounded-xl flex justify-between items-center">
            <span class="font-bold text-slate-700">${idx+1}주 (${actualDate.slice(5)})</span>
            <span class="font-extrabold text-blue-700">대면 ${ip}명 / 비대면 ${on}명 (총 ${ip+on}명)</span>
        </div>`;
    });
    document.getElementById("month-stats-content").innerHTML = html;
    document.getElementById("month-stats-modal").classList.remove("hidden");
}

function closeMonthStatsModal() {
    document.getElementById("month-stats-modal").classList.add("hidden");
}

function showHelpTooltip(key) {
    const text = HELP_CONTENTS[key] || "도움말 정보가 없습니다.";
    alert(text);
}

// =========================================================================
// 12. 전역 객체 바인딩
// =========================================================================
window.app = {
    onMonthChange, onSessionChange,
    switchToEasyMode, openAuthModal, closeAuthModal, pressPin, clearPin, submitPin,
    addEasyCount, setEasyCountDirect, saveEasySession, unlockEditMode,
    addZone, setZoneDirect, toggleZoneCheck, saveDetailedSession,
    adjustOnlineDirect, saveOnlineDirect,
    addTemp, saveTempNote,
    copyCurrentReport, exportMonthlyCSV,
    openMasterModal, closeMasterModal, saveMasterSessionConfig, saveMasterPoolConfig,
    openMonthStatsModal, closeMonthStatsModal, showHelpTooltip
};

initApp();
