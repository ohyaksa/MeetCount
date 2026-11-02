import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    getFirestore, doc, getDoc, setDoc, onSnapshot,
    collection, runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// =========================================================================
// 1. Firebase 프로젝트 설정
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
// 2. 보안 해시 유틸리티 (SHA-256)
// =========================================================================
async function sha256(str) {
    const buf = new TextEncoder().encode(String(str));
    const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// =========================================================================
// 3. 전역 상태(State) 및 도움말 사전
// =========================================================================
const state = {
    role: "easy",             // 'easy' | 'hybrid' | 'master'
    pinInput: "",
    authHashes: { userPinHash: "", masterPinHash: "" },
    thisMonthYM: "",          // 오늘 기준 'YYYY-MM'
    currentMonth: "",         // 현재 선택된 'YYYY-MM'
    currentSessionId: "",     // 현재 선택된 회차 ID
    easyEditLocked: false,    // 쉬운 모드 저장 후 임시 잠금 여부
    monthPool: {
        publisherCount: 100,
        interestedList: [],
        onlineOnlyList: []
    },
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
    special: "특별모임",
    none: "집회없음"
};

const HELP_DICTIONARY = {
    easy_mode: {
        title: "🟢 쉬운 모드 안내",
        text: "• 암호 없이 누구나 당일 집회의 [대면 참석수]와 [비대면 참석수]를 간편하게 입력·저장할 수 있습니다.\n• 입력 후 [저장]을 누르면 접속한 모든 사람의 화면에 실시간으로 반영됩니다.\n• 당일이 지난 예전 기록은 수정할 수 없으며, [이번달보기]로 이번 달 통계만 열람할 수 있습니다."
    },
    easy_session: {
        title: "📌 집회 구분 선택 안내",
        text: "• 이번 달의 평일집회(목요일, 순회주간은 화요일)와 주말집회(일요일) 중 집계할 회차를 선택합니다.\n• 접속 시 오늘 날짜와 가장 가까운 집회가 자동으로 선택됩니다."
    },
    easy_inperson: {
        title: "🏛️ 대면 집회 인원 입력",
        text: "• 회관 현장에 참석한 전체 인원수를 입력합니다.\n• 가운데 숫자 칸을 터치하여 키패드로 한 번에 숫자를 입력하거나, 좌우의 (-) (+) 버튼으로 1명씩 가감할 수 있습니다."
    },
    easy_online: {
        title: "💻 비대면 집회 인원 입력",
        text: "• 줌(Zoom)이나 스트리밍으로 참석한 비대면 총인원수를 입력합니다.\n• 숫자를 직접 타이핑하거나 (-) (+) 버튼으로 조절할 수 있습니다."
    },
    pin_roles: {
        title: "🔒 사용자 그룹별 입장코드 안내",
        text: "사용자는 3그룹으로 나뉩니다.\n\n1) 쉬운 모드 (암호 없음): 당일 대면·비대면 총합 입력 및 이번 달 통계 조회\n2) 하이브리드 모드 (암호 0000): 회관 구조별(연단, 좌·중·우 청중석, 확성, 마이크, 안내, 장로실 등) 당일 상세 입력 및 이번 달 통계 조회\n3) 마스터 모드 (암호 1935): 당일 임시 참석자(4종) 입력, 과거 모든 날짜 수정, 일정 변경(순회주간/집회없음), 전도인 모수 설정 등 모든 권한 보유"
    },
    dash_total: {
        title: "📊 총 참석자 안내",
        text: "• 대면 참석자 합계와 비대면 참석자 합계를 더한 총인원입니다.\n• 구역별 숫자를 조작하면 모든 안내원의 화면에서 실시간으로 합산됩니다."
    },
    dash_general_rate: {
        title: "📈 일반 통계 참석률 안내",
        text: "• 계산식: (총 참석자 ÷ 기본 전도인 수) × 100\n• 방문자나 관심자를 차감하지 않은 전체 참석 인원 대비 전도인 비율입니다."
    },
    real_inperson: {
        title: "🏛️ 대면 실질 참석률 안내",
        text: "• 계산식: (대면 합계 - 당일 임시 참석자) ÷ 대면 참석 가능 인원 × 100\n• 외부 방문자(순회감독자, 연사, 특별방문자 등)와 비대면 전용 인원을 제외하여 실제 회중 성원들의 현장 참석 비율을 분석합니다."
    },
    real_total: {
        title: "🌐 전체 실질 참석률 안내",
        text: "• 계산식: (총 참석자 - 당일 임시 참석자) ÷ 회중 총인원(전도인+정기관심자) × 100\n• 임시 방문자를 제외한 순수 회중 성원(전도인+정기 관심자)의 전체 참석률입니다."
    },
    hall_layout: {
        title: "🏛️ 회관 실제 구조별 카운터 안내",
        text: "우리 회관의 실제 좌석 및 공간 구조에 맞춰 구성되어 있습니다.\n\n• 가장 앞: 연단\n• 청중석 3구역: 왼쪽(창가 4칸) / 가운데(중앙 6칸) / 오른쪽(벽쪽 4칸)\n• 뒤쪽 3구역: 왼쪽(확성부) / 가운데(마이크·뒷좌석) / 오른쪽(안내부)\n• 뒤 오른쪽 별도 방: 장로회의실 (홀의 1/4 공간, 참석 확인 체크 포함)\n• 기타: 실외/로비 또는 쉬운 모드에서 일괄 입력된 인원"
    },
    rear_zones: {
        title: "🪑 청중석 뒤쪽 공간 안내",
        text: "• 확성부(뒤 왼쪽): 음향·영상 봉사자\n• 마이크·뒷좌석(뒤 가운데): 청중 마이크 전달자 또는 잠깐 뒤쪽에 앉은 인원\n• 안내부(뒤 오른쪽): 안내 봉사자"
    },
    temp_visitors: {
        title: "👑 당일 임시 참석자 (마스터 전용)",
        text: "• 순회감독자 부부, 전파자학교 학생, 외부 공개강연 연사, 특별 방문자(여행객·타 지역 가족 등) 인원을 기록합니다.\n• 여기에 입력된 인원은 실질 참석률 계산 시 분자에서 자동 차감됩니다."
    },
    monthly_table: {
        title: "📅 월간 누적 통계표 안내",
        text: "• 해당 월의 평일집회와 주말집회 참석 추이를 주차별로 보여줍니다.\n• 표의 행(Row)을 터치하면 해당 날짜의 집회 카운터로 즉시 이동합니다.\n• ‘집회 없음(대회 등)’으로 설정된 회차는 월평균 계산에서 자동 제외됩니다."
    }
};

// =========================================================================
// 4. 날짜 계산 및 초기 데이터 구조 생성기 (한국 표준시 KST 기준)
// =========================================================================
function getTodayKST() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return {
        ymd: `${y}-${m}-${d}`,
        ym: `${y}-${m}`,
        year: y,
        month: now.getMonth() + 1
    };
}

function formatLocalYYYYMMDD(y, m, d) {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function getDayOfWeekKor(dateStr) {
    if (!dateStr) return "";
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const [y, m, d] = dateStr.split("-").map(Number);
    return days[new Date(y, m - 1, d).getDay()] || "";
}

function shiftDateDays(dateStr, diffDays) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d + diffDays);
    return formatLocalYYYYMMDD(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// 해당 년월(YYYY-MM)의 기본 목요일(평일) / 일요일(주말) 일정 생성
function generateMonthSchedule(ym) {
    const [y, m] = ym.split("-").map(Number);
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
            attendant: 0,
            outdoor: 0,
            eldersRoom: 0,
            eldersRoomChecked: false
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

function getCurrentSessionMeta(ym, sessionId) {
    const schedule = generateMonthSchedule(ym);
    return schedule.find(s => s.id === sessionId) || {
        id: sessionId,
        category: sessionId.includes("weekday") ? "weekday" : "weekend",
        defaultDate: sessionId.slice(0, 10)
    };
}

// =========================================================================
// 5. 앱 초기화 및 Firebase 인증
// =========================================================================
async function initApp() {
    const kst = getTodayKST();
    state.thisMonthYM = kst.ym;
    state.currentMonth = kst.ym;

    const easyMonthBadge = document.getElementById("easy-month-badge");
    if (easyMonthBadge) {
        easyMonthBadge.innerText = `${kst.year}년 ${kst.month}월`;
    }

    try {
        await signInAnonymously(auth);
    } catch (e) {
        console.info("익명 로그인 없이 진행합니다:", e.code);
    }

    // 기본 암호 해시 준비 (일반: 0000 / 마스터: 1935)
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
            }, { merge: true });
        }
    } catch (err) {
        console.warn("암호 설정 로드 중 기본값 사용:", err);
    }

    buildMonthDropdown();
    await subscribeMonthData(state.currentMonth);
    switchToEasyMode();
}

// =========================================================================
// 6. 월(Month) 및 회차(Session) 드롭다운 구성 & 실시간 구독
// =========================================================================
function buildMonthDropdown() {
    const sel = document.getElementById("month-selector");
    if (!sel) return;
    sel.innerHTML = "";

    const now = new Date();
    // 마스터 모드일 때는 과거 6개월~미래 4개월 표시, 하이브리드는 이번 달만 선택 가능
    const startOffset = state.role === "master" ? -6 : 0;
    const endOffset = state.role === "master" ? 4 : 0;

    for (let offset = startOffset; offset <= endOffset; offset++) {
        const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const opt = document.createElement("option");
        opt.value = ym;
        opt.innerText = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
        sel.appendChild(opt);
    }

    if (state.role !== "master") {
        state.currentMonth = state.thisMonthYM;
    }
    sel.value = state.currentMonth;

    const hint = document.getElementById("month-lock-hint");
    if (hint) {
        hint.innerText = state.role === "master" ? "(전체기간 열람)" : "(이번달 전용)";
    }
}

async function onMonthChange() {
    const sel = document.getElementById("month-selector");
    if (!sel) return;
    if (state.role !== "master" && sel.value !== state.thisMonthYM) {
        alert("이번 달 외의 다른 달 조회는 마스터 관리자만 가능합니다.");
        sel.value = state.thisMonthYM;
        return;
    }
    state.currentMonth = sel.value;
    await subscribeMonthData(state.currentMonth);
}

function onSessionChange() {
    const sel = document.getElementById("session-selector");
    if (!sel) return;
    state.currentSessionId = sel.value;
    state.easyEditLocked = false;
    subscribeSingleSession(state.currentMonth, state.currentSessionId);
}

function onEasySessionChange(sessionId) {
    if (!sessionId) return;
    state.currentSessionId = sessionId;
    state.easyEditLocked = false;
    const detailSel = document.getElementById("session-selector");
    if (detailSel) detailSel.value = sessionId;
    subscribeSingleSession(state.currentMonth, state.currentSessionId);
}

async function subscribeMonthData(ym) {
    if (state.unsubPool) state.unsubPool();
    if (state.unsubMonthAll) state.unsubMonthAll();

    const monthRef = doc(db, "months", ym);
    try {
        const snap = await getDoc(monthRef);
        if (!snap.exists()) {
            // 이전 달 데이터가 있으면 자동 이월, 없으면 기본값 생성
            const [y, m] = ym.split("-").map(Number);
            const prevDate = new Date(y, m - 2, 1);
            const prevYM = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
            const prevSnap = await getDoc(doc(db, "months", prevYM));
            if (prevSnap.exists()) {
                const pd = prevSnap.data();
                await setDoc(monthRef, {
                    publisherCount: Number(pd.publisherCount ?? 100),
                    interestedList: Array.isArray(pd.interestedList) ? pd.interestedList : [],
                    onlineOnlyList: Array.isArray(pd.onlineOnlyList) ? pd.onlineOnlyList : []
                }, { merge: true });
            } else {
                await setDoc(monthRef, {
                    publisherCount: 100,
                    interestedList: [],
                    onlineOnlyList: []
                }, { merge: true });
            }
        }
    } catch (e) {
        console.warn("월간 모수 초기화 확인 중 경고:", e);
    }

    state.unsubPool = onSnapshot(monthRef, (docSnap) => {
        if (docSnap.exists()) {
            const d = docSnap.data();
            state.monthPool = {
                publisherCount: Number(d.publisherCount ?? 100),
                interestedList: Array.isArray(d.interestedList) ? d.interestedList : [],
                onlineOnlyList: Array.isArray(d.onlineOnlyList) ? d.onlineOnlyList : []
            };
            renderUI();
            renderMonthlyTables();
        }
    });

    const baseSchedule = generateMonthSchedule(ym);
    const sessionsColRef = collection(db, "months", ym, "sessions");

    state.unsubMonthAll = onSnapshot(sessionsColRef, (querySnap) => {
        const map = {};
        querySnap.forEach(sDoc => {
            map[sDoc.id] = sDoc.data();
        });
        state.allMonthSessionsMap = map;
        populateSessionDropdowns(baseSchedule, map);
        renderMonthlyTables();
    });

    // 오늘 날짜와 가장 가까운 집회 자동 선택
    const todayStr = getTodayKST().ymd;
    let chosen = baseSchedule.find(s => s.defaultDate >= todayStr) || baseSchedule[baseSchedule.length - 1];
    if (chosen) {
        state.currentSessionId = chosen.id;
        subscribeSingleSession(ym, state.currentSessionId);
    }
}

function populateSessionDropdowns(baseSchedule, map) {
    const detailSel = document.getElementById("session-selector");
    const easySel = document.getElementById("easy-session-selector");
    if (detailSel) detailSel.innerHTML = "";
    if (easySel) easySel.innerHTML = "";

    baseSchedule.forEach((item, idx) => {
        const saved = map[item.id];
        const actualDate = (saved && saved.actualDate) ? saved.actualDate : item.defaultDate;
        const dow = getDayOfWeekKor(actualDate);
        const catName = item.category === "weekday" ? "평일집회" : "주말집회";
        const subType = saved?.subType || "normal";
        const statusSuffix = subType !== "normal" ? ` [${SUBTYPE_LABELS[subType] || ""}]` : "";
        const labelText = `${actualDate.slice(5)} (${dow}) · ${catName}${statusSuffix}`;

        if (detailSel) {
            const opt1 = document.createElement("option");
            opt1.value = item.id;
            opt1.innerText = labelText;
            detailSel.appendChild(opt1);
        }
        if (easySel && state.currentMonth === state.thisMonthYM) {
            const opt2 = document.createElement("option");
            opt2.value = item.id;
            opt2.innerText = labelText;
            easySel.appendChild(opt2);
        }
    });

    if (state.currentSessionId) {
        if (detailSel) detailSel.value = state.currentSessionId;
        if (easySel && state.currentMonth === state.thisMonthYM) easySel.value = state.currentSessionId;
    }
}

function subscribeSingleSession(ym, sessionId) {
    if (state.unsubSession) state.unsubSession();

    const meta = getCurrentSessionMeta(ym, sessionId);
    const sessionRef = doc(db, "months", ym, "sessions", sessionId);

    state.unsubSession = onSnapshot(sessionRef, async (docSnap) => {
        if (!docSnap.exists()) {
            const defaultData = createDefaultSessionDoc(meta);
            try {
                await setDoc(sessionRef, defaultData, { merge: true });
            } catch (e) {
                console.warn("기본 회차 문서 생성 대기:", e);
            }
            state.sessionData = defaultData;
        } else {
            const raw = docSnap.data();
            const def = createDefaultSessionDoc(meta);
            state.sessionData = {
                ...def,
                ...raw,
                inPerson: { ...def.inPerson, ...(raw.inPerson || {}) },
                online: { ...def.online, ...(raw.online || {}) },
                temp: { ...def.temp, ...(raw.temp || {}) }
            };
        }
        renderUI();
    });
}

// =========================================================================
// 7. 합계 계산 및 화면 렌더링 (쉬운 모드 & 상세 모드 동시 반영)
// =========================================================================
function getSeatSum(ip) {
    if (!ip) return 0;
    return (Number(ip.seatLeft) || 0) +
           (Number(ip.seatCenter) || 0) +
           (Number(ip.seatRight) || 0);
}

function getInPersonSum(ip) {
    if (!ip) return 0;
    return (Number(ip.platform) || 0) +
           (Number(ip.seatLeft) || 0) +
           (Number(ip.seatCenter) || 0) +
           (Number(ip.seatRight) || 0) +
           (Number(ip.soundBooth) || 0) +
           (Number(ip.rearAttendant) || 0) +
           (Number(ip.attendant) || 0) +
           (Number(ip.outdoor) || 0) +
           (Number(ip.eldersRoom) || 0);
}

function getTempSum(tp) {
    if (!tp) return 0;
    return (Number(tp.circuitOverseer) || 0) +
           (Number(tp.skeStudents) || 0) +
           (Number(tp.publicSpeaker) || 0) +
           (Number(tp.specialVisitors) || 0);
}

// 현재 선택된 회차가 수정 가능한 날짜인지 판별 (당일이 지난 과거 날짜는 마스터만 수정 가능)
function isCurrentSessionEditable() {
    if (state.role === "master") return true;
    const todayStr = getTodayKST().ymd;
    const sessionDate = state.sessionData?.actualDate || state.sessionData?.defaultDate || todayStr;
    return sessionDate >= todayStr;
}

function renderUI() {
    const d = state.sessionData;
    if (!d) return;

    const ip = d.inPerson || {};
    const seatSum = getSeatSum(ip);
    const ipSum = getInPersonSum(ip);
    const onSum = Number(d.online?.total) || 0;
    const onDev = Number(d.online?.devices) || 0;
    const grandTotal = ipSum + onSum;
    const tempSum = getTempSum(d.temp);

    // 모수 계산
    const pubCount = Number(state.monthPool.publisherCount) || 100;
    const interestedCount = (state.monthPool.interestedList || []).length;
    const onlineOnlyCount = (state.monthPool.onlineOnlyList || []).length;
    const totalPool = pubCount + interestedCount;
    const inPersonCapable = Math.max(0, totalPool - onlineOnlyCount);

    // 참석률 3종 계산 (0 나누기 방지)
    const generalRate = pubCount > 0 ? ((grandTotal / pubCount) * 100).toFixed(1) : "0.0";
    const netInPerson = Math.max(0, ipSum - tempSum);
    const netTotal = Math.max(0, grandTotal - tempSum);
    const realIpRate = inPersonCapable > 0 ? ((netInPerson / inPersonCapable) * 100).toFixed(1) : "0.0";
    const realTotRate = totalPool > 0 ? ((netTotal / totalPool) * 100).toFixed(1) : "0.0";

    // ---------------- 1) 쉬운 모드 화면 업데이트 ----------------
    const easyCatPill = document.getElementById("easy-category-pill");
    if (easyCatPill) {
        const isWeekday = d.category === "weekday";
        easyCatPill.innerText = isWeekday ? "평일집회" : "주말집회";
        easyCatPill.className = isWeekday
            ? "text-[11px] font-extrabold px-2.5 py-0.5 rounded-md bg-blue-50 text-blue-700"
            : "text-[11px] font-extrabold px-2.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700";
    }

    const easyIpInput = document.getElementById("easy-input-inperson");
    const easyOnInput = document.getElementById("easy-input-online");
    if (easyIpInput && document.activeElement !== easyIpInput) easyIpInput.value = ipSum;
    if (easyOnInput && document.activeElement !== easyOnInput) easyOnInput.value = onSum;
    const easyTotalEl = document.getElementById("easy-total-sum");
    if (easyTotalEl) easyTotalEl.innerText = grandTotal;

    // ---------------- 2) 상세 모드 상단 대시보드 업데이트 ----------------
    setText("dash-status-badge", SUBTYPE_LABELS[d.subType] || "정상");
    setText("dash-grand-total", `${grandTotal}명`);
    setText("dash-pub-count", pubCount);
    setText("dash-general-rate", `${generalRate}%`);
    setText("dash-inperson", `${ipSum}명`);
    setText("dash-seat-sub", `청중석 ${seatSum}명`);
    setText("dash-online", `${onSum}명`);
    setText("dash-online-dev", `기기 ${onDev}대`);
    setText("dash-temp", `${tempSum}명`);

    setText("dash-real-ip-formula", `((${ipSum}-${tempSum})÷대면가능${inPersonCapable}명)`);
    setText("dash-real-ip-rate", `${realIpRate}%`);
    setText("dash-real-tot-formula", `((${grandTotal}-${tempSum})÷총원${totalPool}명)`);
    setText("dash-real-tot-rate", `${realTotRate}%`);

    // 집회 없음 배너 표시 제어
    const noMeetingBanner = document.getElementById("no-meeting-banner");
    if (noMeetingBanner) {
        if (d.subType === "none") {
            noMeetingBanner.classList.remove("hidden");
            setText("no-meeting-reason", `사유: ${d.note || "대회 또는 특별 일정"} (월평균 분모에서 자동 제외됨)`);
        } else {
            noMeetingBanner.classList.add("hidden");
        }
    }

    // ---------------- 3) 상세 모드 9개 구역 및 비대면/임시참석자 업데이트 ----------------
    setText("label-inperson-sum", `대면 합계: ${ipSum}명`);
    setText("label-seats-sum", `청중석 소계: ${seatSum}명`);

    setInputValue("val-platform", ip.platform || 0);
    setInputValue("val-seatLeft", ip.seatLeft || 0);
    setInputValue("val-seatCenter", ip.seatCenter || 0);
    setInputValue("val-seatRight", ip.seatRight || 0);
    setInputValue("val-soundBooth", ip.soundBooth || 0);
    setInputValue("val-rearAttendant", ip.rearAttendant || 0);
    setInputValue("val-attendant", ip.attendant || 0);
    setInputValue("val-outdoor", ip.outdoor || 0);
    setInputValue("val-eldersRoom", ip.eldersRoom || 0);

    const eldersCheck = document.getElementById("check-eldersRoom");
    if (eldersCheck) eldersCheck.checked = !!ip.eldersRoomChecked;

    setText("label-online-sum", `비대면: ${onSum}명 (기기 ${onDev}대)`);
    setInputValue("input-online-total", onSum);
    setInputValue("input-online-devices", onDev);

    // 마스터 전용 임시 참석자 4종
    const tp = d.temp || {};
    setText("label-temp-sum", `임시 합계: ${tempSum}명`);
    setInputValue("val-circuitOverseer", tp.circuitOverseer || 0);
    setInputValue("val-skeStudents", tp.skeStudents || 0);
    setInputValue("val-publicSpeaker", tp.publicSpeaker || 0);
    setInputValue("val-specialVisitors", tp.specialVisitors || 0);
    setInputValue("input-specialNote", tp.specialNote || "");

    applyEditPermissions();
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function setInputValue(id, val) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) {
        el.value = val;
    }
}

// =========================================================================
// 8. 권한별 & 날짜별 입력 잠금 제어
// =========================================================================
function applyEditPermissions() {
    const canEditDate = isCurrentSessionEditable();
    const isNoneMeeting = state.sessionData?.subType === "none";

    // 쉬운 모드 상태 표시줄 및 입력창 제어
    const easyNotice = document.getElementById("easy-lock-notice");
    const easyControls = [
        "easy-input-inperson", "easy-input-online",
        "btn-easy-ip-minus", "btn-easy-ip-plus",
        "btn-easy-on-minus", "btn-easy-on-plus",
        "btn-easy-save"
    ];

    if (!canEditDate) {
        if (easyNotice) {
            easyNotice.innerText = "🔒 당일이 지난 예전 기록입니다. (과거 기록 수정은 마스터만 가능)";
            easyNotice.className = "mb-3 px-3 py-2 rounded-xl text-xs font-extrabold bg-rose-50 text-rose-700 border border-rose-200 text-center";
        }
        easyControls.forEach(id => setDisabled(id, true));
    } else if (isNoneMeeting && state.role !== "master") {
        if (easyNotice) {
            easyNotice.innerText = "🚫 이번 회차는 ‘집회 없음’ 기간입니다.";
            easyNotice.className = "mb-3 px-3 py-2 rounded-xl text-xs font-extrabold bg-amber-50 text-amber-800 border border-amber-200 text-center";
        }
        easyControls.forEach(id => setDisabled(id, true));
    } else if (state.easyEditLocked) {
        if (easyNotice) {
            easyNotice.innerText = "✅ 저장 완료! 숫자를 다시 고치려면 아래 [✏️ 수정] 버튼을 눌러주세요.";
            easyNotice.className = "mb-3 px-3 py-2 rounded-xl text-xs font-extrabold bg-blue-50 text-blue-800 border border-blue-200 text-center";
        }
        easyControls.forEach(id => setDisabled(id, true));
    } else {
        if (easyNotice) {
            easyNotice.innerText = "🟢 현재 회차는 실시간 입력 및 저장·수정이 가능합니다.";
            easyNotice.className = "mb-3 px-3 py-2 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 text-center";
        }
        easyControls.forEach(id => setDisabled(id, false));
    }

    // 상세 모드(하이브리드 / 마스터) 잠금 배너 및 입력 제어
    const detailLockBanner = document.getElementById("detailed-lock-banner");
    if (detailLockBanner) {
        if (!canEditDate) {
            detailLockBanner.classList.remove("hidden");
        } else {
            detailLockBanner.classList.add("hidden");
        }
    }

    const detailInputs = document.querySelectorAll("#screen-detailed input[type='number'], #screen-detailed input[type='checkbox'], #screen-detailed input[type='text']");
    detailInputs.forEach(inp => {
        inp.disabled = !canEditDate;
    });
}

function setDisabled(id, flag) {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = flag;
    if (flag) {
        el.classList.add("opacity-50", "cursor-not-allowed");
    } else {
        el.classList.remove("opacity-50", "cursor-not-allowed");
    }
}

// =========================================================================
// 9. 쉬운 모드 조작 함수 (저장 / 수정 / 이번달보기)
// =========================================================================
function adjustEasyInput(type, delta) {
    if (!isCurrentSessionEditable()) {
        alert("당일이 지난 예전 기록은 수정할 수 없습니다. (마스터 권한 필요)");
        return;
    }
    if (state.easyEditLocked) {
        state.easyEditLocked = false;
        applyEditPermissions();
    }

    const inputId = type === "inperson" ? "easy-input-inperson" : "easy-input-online";
    const inp = document.getElementById(inputId);
    if (!inp) return;

    const currentVal = parseInt(inp.value, 10) || 0;
    const nextVal = Math.max(0, currentVal + delta);
    inp.value = nextVal;
    onEasyDirectInput();
}

function onEasyDirectInput() {
    const ipVal = Math.max(0, parseInt(document.getElementById("easy-input-inperson")?.value, 10) || 0);
    const onVal = Math.max(0, parseInt(document.getElementById("easy-input-online")?.value, 10) || 0);
    setText("easy-total-sum", ipVal + onVal);
}

async function saveEasyMode() {
    if (!isCurrentSessionEditable()) {
        alert("당일이 지난 예전 기록은 수정할 수 없습니다. (마스터 관리자만 수정 가능)");
        return;
    }

    const targetIpTotal = Math.max(0, parseInt(document.getElementById("easy-input-inperson")?.value, 10) || 0);
    const targetOnTotal = Math.max(0, parseInt(document.getElementById("easy-input-online")?.value, 10) || 0);

    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const ip = { ...createDefaultSessionDoc(meta).inPerson, ...(data.inPerson || {}) };

            // 기존 구역(연단, 좌·중·우 청중석, 확성, 마이크, 안내, 장로실) 합산 보존
            const fixedZonesSum =
                (Number(ip.platform) || 0) +
                (Number(ip.seatLeft) || 0) +
                (Number(ip.seatCenter) || 0) +
                (Number(ip.seatRight) || 0) +
                (Number(ip.soundBooth) || 0) +
                (Number(ip.rearAttendant) || 0) +
                (Number(ip.attendant) || 0) +
                (Number(ip.eldersRoom) || 0);

            if (targetIpTotal >= fixedZonesSum) {
                // 차액을 기타(outdoor: 쉬운모드 연동분)에 반영하여 구역 데이터 보호
                ip.outdoor = targetIpTotal - fixedZonesSum;
            } else {
                // 만약 구역 합계보다 적은 숫자로 덮어썼다면 전체를 초기화하고 outdoor에 반영
                ip.platform = 0;
                ip.seatLeft = 0;
                ip.seatCenter = 0;
                ip.seatRight = 0;
                ip.soundBooth = 0;
                ip.rearAttendant = 0;
                ip.attendant = 0;
                ip.eldersRoom = 0;
                ip.outdoor = targetIpTotal;
            }

            const updatedOnline = {
                devices: Number(data.online?.devices) || (targetOnTotal > 0 ? 1 : 0),
                total: targetOnTotal
            };

            tx.set(ref, {
                ...data,
                inPerson: ip,
                online: updatedOnline
            }, { merge: true });
        });

        state.easyEditLocked = true;
        applyEditPermissions();
    } catch (err) {
        alert("저장 중 오류가 발생했습니다: " + err.message);
    }
}

function enableEasyEdit() {
    if (!isCurrentSessionEditable()) {
        alert("당일이 지난 예전 기록은 수정할 수 없습니다.\n과거 기록 수정은 하단에서 마스터 암호(1935)로 입장해 주세요.");
        return;
    }
    state.easyEditLocked = false;
    applyEditPermissions();
    const ipInput = document.getElementById("easy-input-inperson");
    if (ipInput) {
        ipInput.focus();
        ipInput.select();
    }
}

function toggleEasyMonthlyModal() {
    const modal = document.getElementById("easy-monthly-modal");
    if (!modal) return;
    if (modal.classList.contains("hidden")) {
        renderEasyMonthlyModalContent();
        modal.classList.remove("hidden");
    } else {
        modal.classList.add("hidden");
    }
}

function renderEasyMonthlyModalContent() {
    const container = document.getElementById("easy-monthly-body");
    if (!container) return;

    const schedule = generateMonthSchedule(state.thisMonthYM);
    const weekdays = schedule.filter(s => s.category === "weekday");
    const weekends = schedule.filter(s => s.category === "weekend");

    const buildMiniTable = (title, items, badgeColor) => {
        let sumIp = 0, sumOn = 0, sumTot = 0, validCnt = 0;
        let rowsHtml = "";

        items.forEach((item, idx) => {
            const d = state.allMonthSessionsMap[item.id] || createDefaultSessionDoc(item);
            const actualDate = d.actualDate || item.defaultDate;
            const dow = getDayOfWeekKor(actualDate);
            const isNone = d.subType === "none";
            const ip = getInPersonSum(d.inPerson);
            const on = Number(d.online?.total) || 0;
            const tot = ip + on;

            if (!isNone && tot > 0) {
                sumIp += ip;
                sumOn += on;
                sumTot += tot;
                validCnt++;
            }

            rowsHtml += `
                <tr class="border-b border-slate-100 ${item.id === state.currentSessionId ? "bg-emerald-50/70 font-bold" : ""}">
                    <td class="p-2">${idx + 1}주차 · ${actualDate.slice(5)}(${dow})</td>
                    <td class="p-2 text-right">${isNone ? "-" : ip + "명"}</td>
                    <td class="p-2 text-right">${isNone ? "-" : on + "명"}</td>
                    <td class="p-2 text-right font-extrabold text-blue-700">${isNone ? "집회없음" : tot + "명"}</td>
                </tr>
            `;
        });

        const avgIp = validCnt > 0 ? (sumIp / validCnt).toFixed(1) : "0.0";
        const avgOn = validCnt > 0 ? (sumOn / validCnt).toFixed(1) : "0.0";
        const avgTot = validCnt > 0 ? (sumTot / validCnt).toFixed(1) : "0.0";

        return `
            <div>
                <h4 class="font-extrabold ${badgeColor} px-3 py-1.5 rounded-xl mb-1.5">${title}</h4>
                <table class="w-full text-left border-collapse text-xs">
                    <thead>
                        <tr class="bg-slate-100 text-slate-600 border-b border-slate-200">
                            <th class="p-2">주차/날짜</th>
                            <th class="p-2 text-right">대면</th>
                            <th class="p-2 text-right">비대면</th>
                            <th class="p-2 text-right">합계</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                    <tfoot>
                        <tr class="bg-slate-800 text-white font-extrabold">
                            <td class="p-2">이번 달 평균 (${validCnt}회)</td>
                            <td class="p-2 text-right">${avgIp}명</td>
                            <td class="p-2 text-right">${avgOn}명</td>
                            <td class="p-2 text-right text-amber-300">${avgTot}명</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;
    };

    container.innerHTML =
        buildMiniTable("■ 1. 평일집회 (이번 달)", weekdays, "bg-blue-50 text-blue-800") +
        buildMiniTable("■ 2. 주말집회 (이번 달)", weekends, "bg-indigo-50 text-indigo-800");
}

// =========================================================================
// 10. 상세 모드 구역별(9개 구역) & 비대면 & 임시참석자 조작 함수
// =========================================================================
async function addZone(field, delta) {
    if (!isCurrentSessionEditable()) {
        alert("당일이 지난 예전 기록은 마스터 관리자만 수정할 수 있습니다.");
        return;
    }
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const ip = { ...createDefaultSessionDoc(meta).inPerson, ...(data.inPerson || {}) };
            ip[field] = Math.max(0, (Number(ip[field]) || 0) + delta);
            tx.set(ref, { ...data, inPerson: ip }, { merge: true });
        });
    } catch (err) {
        console.error("구역 가감 오류:", err);
    }
}

async function setZoneDirect(field, val) {
    if (!isCurrentSessionEditable()) {
        alert("당일이 지난 예전 기록은 마스터 관리자만 수정할 수 있습니다.");
        renderUI();
        return;
    }
    const num = Math.max(0, parseInt(val, 10) || 0);
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const ip = { ...createDefaultSessionDoc(meta).inPerson, ...(data.inPerson || {}) };
            ip[field] = num;
            tx.set(ref, { ...data, inPerson: ip }, { merge: true });
        });
    } catch (err) {
        console.error("구역 직접 입력 오류:", err);
    }
}

async function toggleZoneCheck(field) {
    if (!isCurrentSessionEditable()) {
        renderUI();
        return;
    }
    const checkEl = document.getElementById(`check-${field}`);
    const checked = checkEl ? checkEl.checked : false;
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const ip = { ...createDefaultSessionDoc(meta).inPerson, ...(data.inPerson || {}) };
            ip[`${field}Checked`] = checked;
            tx.set(ref, { ...data, inPerson: ip }, { merge: true });
        });
    } catch (err) {
        console.error("확인 체크 오류:", err);
    }
}

async function adjustOnlineDirect(field, delta) {
    if (!isCurrentSessionEditable()) {
        alert("당일이 지난 예전 기록은 마스터 관리자만 수정할 수 있습니다.");
        return;
    }
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const on = { devices: 0, total: 0, ...(data.online || {}) };
            on[field] = Math.max(0, (Number(on[field]) || 0) + delta);
            tx.set(ref, { ...data, online: on }, { merge: true });
        });
    } catch (err) {
        console.error("비대면 가감 오류:", err);
    }
}

async function saveOnlineDirect() {
    if (!isCurrentSessionEditable()) {
        renderUI();
        return;
    }
    const total = Math.max(0, parseInt(document.getElementById("input-online-total")?.value, 10) || 0);
    const devices = Math.max(0, parseInt(document.getElementById("input-online-devices")?.value, 10) || 0);
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            tx.set(ref, { ...data, online: { total, devices } }, { merge: true });
        });
    } catch (err) {
        console.error("비대면 저장 오류:", err);
    }
}

// 마스터 전용: 당일 임시 참석자 4종 조작
async function addTemp(field, delta) {
    if (state.role !== "master") {
        alert("당일 임시 참석자 입력은 마스터 관리자만 가능합니다.");
        return;
    }
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const tp = { ...createDefaultSessionDoc(meta).temp, ...(data.temp || {}) };
            tp[field] = Math.max(0, (Number(tp[field]) || 0) + delta);
            tx.set(ref, { ...data, temp: tp }, { merge: true });
        });
    } catch (err) {
        console.error("임시 참석자 가감 오류:", err);
    }
}

async function setTempDirect(field, val) {
    if (state.role !== "master") {
        renderUI();
        return;
    }
    const num = Math.max(0, parseInt(val, 10) || 0);
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const tp = { ...createDefaultSessionDoc(meta).temp, ...(data.temp || {}) };
            tp[field] = num;
            tx.set(ref, { ...data, temp: tp }, { merge: true });
        });
    } catch (err) {
        console.error("임시 참석자 직접 입력 오류:", err);
    }
}

async function saveTempNote() {
    if (state.role !== "master") return;
    const note = document.getElementById("input-specialNote")?.value.trim() || "";
    const ym = state.currentMonth;
    const sessionId = state.currentSessionId;
    const meta = getCurrentSessionMeta(ym, sessionId);
    const ref = doc(db, "months", ym, "sessions", sessionId);

    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists() ? snap.data() : createDefaultSessionDoc(meta);
            const tp = { ...createDefaultSessionDoc(meta).temp, ...(data.temp || {}), specialNote: note };
            tx.set(ref, { ...data, temp: tp }, { merge: true });
        });
    } catch (err) {
        console.error("임시 참석자 메모 저장 오류:", err);
    }
}

// =========================================================================
// 11. 월간 누적 통계표 렌더링 & 보고서 복사 / 엑셀(CSV) 내보내기
// =========================================================================
function renderMonthlyTables() {
    const baseSchedule = generateMonthSchedule(state.currentMonth);
    const weekdays = baseSchedule.filter(s => s.category === "weekday");
    const weekends = baseSchedule.filter(s => s.category === "weekend");

    renderCategoryTable("tbody-weekday", weekdays);
    renderCategoryTable("tbody-weekend", weekends);
}

function renderCategoryTable(tbodyId, items) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    const pubCount = Number(state.monthPool.publisherCount) || 100;
    const interestedCount = (state.monthPool.interestedList || []).length;
    const totalPool = pubCount + interestedCount;

    let sumIp = 0, sumOn = 0, sumTot = 0, sumGenRate = 0, sumRealRate = 0, validCnt = 0;
    let html = "";

    items.forEach((item, idx) => {
        const d = state.allMonthSessionsMap[item.id] || createDefaultSessionDoc(item);
        const actualDate = d.actualDate || item.defaultDate;
        const dow = getDayOfWeekKor(actualDate);
        const isNone = d.subType === "none";

        const ip = getInPersonSum(d.inPerson);
        const on = Number(d.online?.total) || 0;
        const tot = ip + on;
        const tempSum = getTempSum(d.temp);

        const genRate = pubCount > 0 ? (tot / pubCount) * 100 : 0;
        const realTotRate = totalPool > 0 ? (Math.max(0, tot - tempSum) / totalPool) * 100 : 0;

        if (!isNone && tot > 0) {
            sumIp += ip;
            sumOn += on;
            sumTot += tot;
            sumGenRate += genRate;
            sumRealRate += realTotRate;
            validCnt++;
        }

        const isSelected = item.id === state.currentSessionId;
        const badgeHtml = d.subType && d.subType !== "normal"
            ? `<span class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">${SUBTYPE_LABELS[d.subType]}</span>`
            : "";

        html += `
            <tr onclick="app.selectSessionFromTable('${item.id}')" class="cursor-pointer border-b border-slate-100 hover:bg-blue-50/60 transition ${isSelected ? "bg-blue-50 font-bold" : ""}">
                <td class="p-2">${idx + 1}주 · ${actualDate.slice(5)}(${dow})${badgeHtml}</td>
                <td class="p-2 text-right">${isNone ? "-" : ip}</td>
                <td class="p-2 text-right">${isNone ? "-" : on}</td>
                <td class="p-2 text-right font-extrabold text-blue-700">${isNone ? "제외" : tot}</td>
                <td class="p-2 text-right">${isNone ? "-" : genRate.toFixed(1) + "%"}</td>
                <td class="p-2 text-right text-emerald-700 font-bold">${isNone ? "-" : realTotRate.toFixed(1) + "%"}</td>
            </tr>
        `;
    });

    const avgIp = validCnt > 0 ? (sumIp / validCnt).toFixed(1) : "0.0";
    const avgOn = validCnt > 0 ? (sumOn / validCnt).toFixed(1) : "0.0";
    const avgTot = validCnt > 0 ? (sumTot / validCnt).toFixed(1) : "0.0";
    const avgGen = validCnt > 0 ? (sumGenRate / validCnt).toFixed(1) : "0.0";
    const avgReal = validCnt > 0 ? (sumRealRate / validCnt).toFixed(1) : "0.0";

    html += `
        <tr class="bg-slate-800 text-white font-extrabold">
            <td class="p-2">월평균 (${validCnt}회)</td>
            <td class="p-2 text-right">${avgIp}</td>
            <td class="p-2 text-right">${avgOn}</td>
            <td class="p-2 text-right text-amber-300">${avgTot}</td>
            <td class="p-2 text-right">${avgGen}%</td>
            <td class="p-2 text-right text-emerald-300">${avgReal}%</td>
        </tr>
    `;

    tbody.innerHTML = html;
}

function selectSessionFromTable(sessionId) {
    state.currentSessionId = sessionId;
    const sel = document.getElementById("session-selector");
    if (sel) sel.value = sessionId;
    subscribeSingleSession(state.currentMonth, sessionId);
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function copyCurrentReport() {
    const d = state.sessionData;
    if (!d) return;

    const ip = d.inPerson || {};
    const seatSum = getSeatSum(ip);
    const ipSum = getInPersonSum(ip);
    const onSum = Number(d.online?.total) || 0;
    const onDev = Number(d.online?.devices) || 0;
    const grandTotal = ipSum + onSum;
    const tempSum = getTempSum(d.temp);

    const pubCount = Number(state.monthPool.publisherCount) || 100;
    const interestedCount = (state.monthPool.interestedList || []).length;
    const onlineOnlyCount = (state.monthPool.onlineOnlyList || []).length;
    const totalPool = pubCount + interestedCount;
    const inPersonCapable = Math.max(0, totalPool - onlineOnlyCount);

    const generalRate = pubCount > 0 ? ((grandTotal / pubCount) * 100).toFixed(1) : "0.0";
    const realIpRate = inPersonCapable > 0 ? ((Math.max(0, ipSum - tempSum) / inPersonCapable) * 100).toFixed(1) : "0.0";
    const realTotRate = totalPool > 0 ? ((Math.max(0, grandTotal - tempSum) / totalPool) * 100).toFixed(1) : "0.0";

    const actualDate = d.actualDate || d.defaultDate;
    const dow = getDayOfWeekKor(actualDate);
    const catName = d.category === "weekday" ? "평일집회" : "주말집회";

    const reportText = [
        `📊 [MeetCount ${catName} 참석 보고]`,
        `• 일시: ${actualDate} (${dow}) [${SUBTYPE_LABELS[d.subType] || "정상"}]`,
        `• 총 참석자: ${grandTotal}명 (전도인 ${pubCount}명 대비 ${generalRate}%)`,
        `--------------------------------`,
        `🏛️ 대면 합계: ${ipSum}명`,
        `  - 연단: ${ip.platform || 0}명`,
        `  - 청중석: ${seatSum}명 (좌 ${ip.seatLeft || 0} / 중 ${ip.seatCenter || 0} / 우 ${ip.seatRight || 0})`,
        `  - 뒤쪽 공간: 확성 ${ip.soundBooth || 0} / 마이크·뒷좌석 ${ip.rearAttendant || 0} / 안내 ${ip.attendant || 0}`,
        `  - 장로회의실: ${ip.eldersRoom || 0}명 / 기타: ${ip.outdoor || 0}명`,
        `💻 비대면 합계: ${onSum}명 (기기 ${onDev}대)`,
        `🧳 임시 참석자: ${tempSum}명`,
        `--------------------------------`,
        `📈 대면 실질 참석률: ${realIpRate}%`,
        `📈 전체 실질 참석률: ${realTotRate}%`
    ].join("\n");

    navigator.clipboard.writeText(reportText).then(() => {
        alert("📋 현재 회차 보고서가 클립보드에 복사되었습니다.\n메신저 채팅방에 붙여넣기 하세요!");
    }).catch(() => {
        prompt("아래 내용을 복사하세요:", reportText);
    });
}

function exportMonthlyCSV() {
    const baseSchedule = generateMonthSchedule(state.currentMonth);
    let csv = "\uFEFF날짜,요일,구분,상태,연단,왼쪽청중석,가운데청중석,오른쪽청중석,확성부,마이크뒷좌석,안내부,장로회의실,기타,대면합계,비대면기기,비대면합계,총참석자,임시참석자\n";

    baseSchedule.forEach(item => {
        const d = state.allMonthSessionsMap[item.id] || createDefaultSessionDoc(item);
        const actualDate = d.actualDate || item.defaultDate;
        const dow = getDayOfWeekKor(actualDate);
        const cat = item.category === "weekday" ? "평일" : "주말";
        const status = SUBTYPE_LABELS[d.subType] || "정상";
        const ip = d.inPerson || {};
        const ipSum = getInPersonSum(ip);
        const onDev = Number(d.online?.devices) || 0;
        const onSum = Number(d.online?.total) || 0;
        const tempSum = getTempSum(d.temp);

        csv += [
            actualDate, dow, cat, status,
            ip.platform || 0, ip.seatLeft || 0, ip.seatCenter || 0, ip.seatRight || 0,
            ip.soundBooth || 0, ip.rearAttendant || 0, ip.attendant || 0, ip.eldersRoom || 0, ip.outdoor || 0,
            ipSum, onDev, onSum, ipSum + onSum, tempSum
        ].join(",") + "\n";
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `MeetCount_${state.currentMonth}_집회통계.csv`;
    a.click();
}

// =========================================================================
// 12. 3단계 사용자 그룹 전환 (쉬운 모드 / 하이브리드 0000 / 마스터 1935)
// =========================================================================
function onPinInputDirect(val) {
    state.pinInput = String(val).replace(/[^0-9]/g, "").slice(0, 4);
    const inp = document.getElementById("pin-direct-input");
    if (inp && inp.value !== state.pinInput) {
        inp.value = state.pinInput;
    }
    setText("pin-error", "");
}

function pressPin(digit) {
    if (state.pinInput.length < 4) {
        state.pinInput += String(digit);
        const inp = document.getElementById("pin-direct-input");
        if (inp) inp.value = state.pinInput;
        setText("pin-error", "");
        if (state.pinInput.length === 4) {
            setTimeout(() => submitPin(), 100);
        }
    }
}

function clearPin() {
    state.pinInput = "";
    const inp = document.getElementById("pin-direct-input");
    if (inp) inp.value = "";
    setText("pin-error", "");
}

async function submitPin() {
    const inp = document.getElementById("pin-direct-input");
    if (inp && inp.value) {
        state.pinInput = inp.value.trim();
    }
    if (state.pinInput.length !== 4) {
        setText("pin-error", "4자리 숫자를 입력해 주세요.");
        return;
    }

    const inputHash = await sha256(state.pinInput);
    if (inputHash === state.authHashes.masterPinHash) {
        clearPin();
        enterDetailedMode("master");
    } else if (inputHash === state.authHashes.userPinHash) {
        clearPin();
        enterDetailedMode("hybrid");
    } else {
        setText("pin-error", "❌ 입장코드가 일치하지 않습니다. (일반: 0000)");
        state.pinInput = "";
        if (inp) inp.value = "";
    }
}

function switchToEasyMode() {
    state.role = "easy";
    state.easyEditLocked = false;

    // 쉬운 모드는 항상 이번 달로 고정
    if (state.currentMonth !== state.thisMonthYM) {
        state.currentMonth = state.thisMonthYM;
        subscribeMonthData(state.thisMonthYM);
    }

    document.getElementById("screen-easy")?.classList.remove("hidden");
    document.getElementById("screen-detailed")?.classList.add("hidden");
    document.getElementById("btn-go-easy")?.classList.add("hidden");
    document.getElementById("btn-open-master")?.classList.add("hidden");

    const badge = document.getElementById("role-badge");
    if (badge) {
        badge.innerText = "쉬운 모드";
        badge.className = "text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-extrabold";
    }
    renderUI();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function enterDetailedMode(role) {
    state.role = role;
    buildMonthDropdown();

    document.getElementById("screen-easy")?.classList.add("hidden");
    const detailScreen = document.getElementById("screen-detailed");
    if (detailScreen) {
        detailScreen.classList.remove("hidden");
        detailScreen.classList.add("flex");
    }

    document.getElementById("btn-go-easy")?.classList.remove("hidden");
    const masterBtn = document.getElementById("btn-open-master");
    const masterSection = document.getElementById("master-only-section");
    const badge = document.getElementById("role-badge");

    if (role === "master") {
        if (badge) {
            badge.innerText = "마스터 모드 (1935)";
            badge.className = "text-[11px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-extrabold";
        }
        masterBtn?.classList.remove("hidden");
        masterSection?.classList.remove("hidden");
    } else {
        if (badge) {
            badge.innerText = "하이브리드 모드 (0000)";
            badge.className = "text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-extrabold";
        }
        masterBtn?.classList.add("hidden");
        masterSection?.classList.add("hidden");
    }

    renderUI();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

// =========================================================================
// 13. 마스터 관리자 설정 모달 (일정 변경 / 명단 모수 / 암호 변경 / 초기화)
// =========================================================================
function openMasterModal() {
    if (state.role !== "master") return;
    const d = state.sessionData || {};

    setInputValue("master-subtype", d.subType || "normal");
    setInputValue("master-custom-date", d.actualDate || d.defaultDate || "");
    setInputValue("master-session-note", d.note || "");
    setInputValue("master-pub-count", state.monthPool.publisherCount || 100);

    renderMasterPersonChips();
    document.getElementById("master-modal")?.classList.remove("hidden");
}

function closeMasterModal() {
    document.getElementById("master-modal")?.classList.add("hidden");
}

function onMasterSubtypeChange() {
    const subType = document.getElementById("master-subtype")?.value;
    const dateInput = document.getElementById("master-custom-date");
    const defDate = state.sessionData?.defaultDate;
    if (!dateInput || !defDate) return;

    // 평일집회 순회주간 선택 시 목요일 -> 화요일(-2일)로 자동 변경
    if (subType === "circuit" && state.sessionData?.category === "weekday") {
        dateInput.value = shiftDateDays(defDate, -2);
    } else if (subType === "normal") {
        dateInput.value = defDate;
    }
}

async function saveMasterSessionConfig() {
    if (state.role !== "master") return;
    const subType = document.getElementById("master-subtype")?.value || "normal";
    const actualDate = document.getElementById("master-custom-date")?.value || state.sessionData?.defaultDate;
    const note = document.getElementById("master-session-note")?.value.trim() || "";

    const ref = doc(db, "months", state.currentMonth, "sessions", state.currentSessionId);
    try {
        await setDoc(ref, { subType, actualDate, note }, { merge: true });
        alert("✅ 회차 일정 및 상태가 저장되었습니다.");
        closeMasterModal();
    } catch (err) {
        alert("저장 오류: " + err.message);
    }
}

function renderMasterPersonChips() {
    const intList = state.monthPool.interestedList || [];
    const onList = state.monthPool.onlineOnlyList || [];

    setText("master-interested-len", `${intList.length}명`);
    setText("master-onlineonly-len", `${onList.length}명`);

    const intWrap = document.getElementById("master-interested-chips");
    if (intWrap) {
        intWrap.innerHTML = intList.map((name, idx) => `
            <span class="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 border border-indigo-200 px-2.5 py-1 rounded-full text-xs font-bold">
                ${name}
                <button type="button" onclick="app.removePersonChip('interested', ${idx})" class="text-indigo-500 hover:text-rose-600 font-black ml-0.5">✕</button>
            </span>
        `).join("");
    }

    const onWrap = document.getElementById("master-onlineonly-chips");
    if (onWrap) {
        onWrap.innerHTML = onList.map((name, idx) => `
            <span class="inline-flex items-center gap-1 bg-rose-50 text-rose-800 border border-rose-200 px-2.5 py-1 rounded-full text-xs font-bold">
                ${name}
                <button type="button" onclick="app.removePersonChip('onlineOnly', ${idx})" class="text-rose-500 hover:text-rose-700 font-black ml-0.5">✕</button>
            </span>
        `).join("");
    }
}

function addPersonChip(listType) {
    const inputId = listType === "interested" ? "input-add-interested" : "input-add-onlineonly";
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const name = inp.value.trim();
    if (!name) return;

    if (listType === "interested") {
        state.monthPool.interestedList = [...(state.monthPool.interestedList || []), name];
    } else {
        state.monthPool.onlineOnlyList = [...(state.monthPool.onlineOnlyList || []), name];
    }
    inp.value = "";
    renderMasterPersonChips();
}

function removePersonChip(listType, idx) {
    if (listType === "interested") {
        state.monthPool.interestedList = (state.monthPool.interestedList || []).filter((_, i) => i !== idx);
    } else {
        state.monthPool.onlineOnlyList = (state.monthPool.onlineOnlyList || []).filter((_, i) => i !== idx);
    }
    renderMasterPersonChips();
}

async function saveMasterPoolConfig() {
    if (state.role !== "master") return;
    const pubCount = Math.max(1, parseInt(document.getElementById("master-pub-count")?.value, 10) || 100);
    const ref = doc(db, "months", state.currentMonth);

    try {
        await setDoc(ref, {
            publisherCount: pubCount,
            interestedList: state.monthPool.interestedList || [],
            onlineOnlyList: state.monthPool.onlineOnlyList || []
        }, { merge: true });
        alert("✅ 회중 기준 인원 및 명단이 저장되었습니다.");
        closeMasterModal();
    } catch (err) {
        alert("모수 저장 오류: " + err.message);
    }
}

async function saveMasterPins() {
    if (state.role !== "master") return;
    const newUserPin = document.getElementById("master-new-userpin")?.value.trim() || "";
    const newMasterPin = document.getElementById("master-new-masterpin")?.value.trim() || "";

    if (!newUserPin && !newMasterPin) {
        alert("변경할 4자리 숫자 암호를 입력해 주세요.");
        return;
    }

    const updates = { updatedAt: new Date().toISOString() };
    if (newUserPin) {
        if (!/^\d{4}$/.test(newUserPin)) {
            alert("일반 암호는 숫자 4자리여야 합니다.");
            return;
        }
        updates.userPinHash = await sha256(newUserPin);
        state.authHashes.userPinHash = updates.userPinHash;
    }
    if (newMasterPin) {
        if (!/^\d{4}$/.test(newMasterPin)) {
            alert("마스터 암호는 숫자 4자리여야 합니다.");
            return;
        }
        updates.masterPinHash = await sha256(newMasterPin);
        state.authHashes.masterPinHash = updates.masterPinHash;
    }

    try {
        await setDoc(doc(db, "settings", "auth"), updates, { merge: true });
        document.getElementById("master-new-userpin").value = "";
        document.getElementById("master-new-masterpin").value = "";
        alert("✅ 새 암호가 안전하게 암호화되어 저장되었습니다.");
    } catch (err) {
        alert("암호 변경 오류: " + err.message);
    }
}

async function resetCurrentSession() {
    if (state.role !== "master") return;
    if (!confirm("정말 현재 선택된 회차의 모든 카운터 숫자를 0으로 초기화하시겠습니까?")) return;

    const meta = getCurrentSessionMeta(state.currentMonth, state.currentSessionId);
    const resetDoc = createDefaultSessionDoc(meta);
    resetDoc.subType = state.sessionData?.subType || "normal";
    resetDoc.actualDate = state.sessionData?.actualDate || meta.defaultDate;
    resetDoc.note = state.sessionData?.note || "";

    try {
        await setDoc(doc(db, "months", state.currentMonth, "sessions", state.currentSessionId), resetDoc);
        alert("✅ 현재 회차 숫자가 모두 0으로 초기화되었습니다.");
        closeMasterModal();
    } catch (err) {
        alert("초기화 오류: " + err.message);
    }
}

// =========================================================================
// 14. 물음표(?) 도움말 모달 제어
// =========================================================================
function showHelp(key) {
    const item = HELP_DICTIONARY[key] || {
        title: "💡 도움말 안내",
        text: "상단 [📖 도움말] 버튼을 누르시면 전체 상세 사용설명서를 확인하실 수 있습니다."
    };
    setText("help-modal-title", item.title);
    setText("help-modal-text", item.text);
    document.getElementById("help-modal")?.classList.remove("hidden");
}

function closeHelp() {
    document.getElementById("help-modal")?.classList.add("hidden");
}

// =========================================================================
// 15. 전역 window.app 객체 바인딩
// =========================================================================
window.app = {
    switchToEasyMode,
    openMasterModal,
    closeMasterModal,
    showHelp,
    closeHelp,
    onEasySessionChange,
    adjustEasyInput,
    onEasyDirectInput,
    saveEasyMode,
    enableEasyEdit,
    toggleEasyMonthlyModal,
    onPinInputDirect,
    pressPin,
    clearPin,
    submitPin,
    onMonthChange,
    onSessionChange,
    addZone,
    setZoneDirect,
    toggleZoneCheck,
    adjustOnlineDirect,
    saveOnlineDirect,
    addTemp,
    setTempDirect,
    saveTempNote,
    copyCurrentReport,
    exportMonthlyCSV,
    selectSessionFromTable,
    onMasterSubtypeChange,
    saveMasterSessionConfig,
    addPersonChip,
    removePersonChip,
    saveMasterPoolConfig,
    saveMasterPins,
    resetCurrentSession
};

initApp();
