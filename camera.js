// ======================================================
// AI人数管理システム・退出専用強化版
// A → B → C = 入室
// C → B → A / C → A = 退出
// ======================================================

// ======================================================
// AI人数管理システム
// 横方向 A・B・C + 高感度 + 退出追跡強化 + Firebase + リセット
//
// A = 左（入口）
// B = 中央
// C = 右（出口）
//
// 入室
// A → B → C
//
// 退出
// C → B → A
// C → A
//
// 重要:
// - Cを通過した「入室済み」の人物がAに到達したら退出確定
// - C→AのようにBが短時間しか検出されなくても退出
// - 同じ人物を繰り返し退出カウントしない
// - Firebaseは people/current と people/reset を使用
// ======================================================


// ======================================================
// AI・カメラ
// ======================================================

let video;
let model;
let predictions = [];


// ======================================================
// 人数
// ======================================================

let visiblePeopleCount = 0;
let enteredCount = 0;
let exitedCount = 0;
let currentPeopleCount = 0;


// ======================================================
// 状態
// ======================================================

let modelReady = false;
let cameraReady = false;
let detecting = false;


// ======================================================
// 人物追跡
// ======================================================

let tracks = [];
let nextTrackId = 1;


// ======================================================
// 感度設定
// ======================================================

// COCO-SSDの人物認識しきい値
// 小さくすると検出しやすくなる
const PERSON_CONFIDENCE = 0.35;

// AI認識から一時的に消えても同じ人物として保持する時間
const TRACK_TIMEOUT = 8000;

// 前回位置からこの距離以内なら同じ人物として追跡
const MATCH_DISTANCE = 320;

// ゾーン境界付近の判定揺れを防ぐ
const ZONE_HYSTERESIS = 0.035;

// AI検出が一時的に途切れても同じ人物として保持する目安
const MAX_MISSED_FRAMES = 12;

// 同じ人物の入退室を短時間に二重計上しない
const COUNT_COOLDOWN = 500;


// ======================================================
// 横方向ゾーン
// ======================================================
//
// ┌──────────┬──────────┬──────────┐
// │    A     │    B     │    C     │
// │   入口   │   中間   │   出口   │
// └──────────┴──────────┴──────────┘
//
// 左 → 右 = 入室
// 右 → 左 = 退出
// ======================================================

const ZONE_A_END = 0.33;
const ZONE_B_END = 0.66;

// 退出専用強化設定（入室判定には使用しない）
const EXIT_A_MARGIN = 0.06;
const EXIT_RECOVERY_TIME = 8000;


// ======================================================
// リセット
// ======================================================

let lastResetTime = 0;


// ======================================================
// キャンバス
// ======================================================

let canvasWidth = 1280;
let canvasHeight = 720;


// ======================================================
// setup
// ======================================================

function setup() {

  updateCanvasSize();

  const canvas = createCanvas(
    canvasWidth,
    canvasHeight
  );

  canvas.parent("app");


  // ==================================================
  // 背面カメラ
  // ==================================================

  video = createCapture(
    {
      video: {
        facingMode: {
          ideal: "environment"
        },

        width: {
          ideal: 1280
        },

        height: {
          ideal: 720
        }
      },

      audio: false
    },

    function () {

      cameraReady = true;

      console.log(
        "背面カメラ接続成功"
      );

      sendPeopleData();

    }
  );

  video.hide();


  // ==================================================
  // AI
  // ==================================================

  loadAIModel();

}


// ======================================================
// キャンバスサイズ
// ======================================================

function updateCanvasSize() {

  if (windowWidth >= windowHeight) {

    canvasWidth = windowWidth;
    canvasHeight = windowHeight;

  } else {

    canvasWidth = windowWidth;
    canvasHeight =
      windowWidth * 9 / 16;

  }

}


// ======================================================
// 画面サイズ変更
// ======================================================

function windowResized() {

  updateCanvasSize();

  resizeCanvas(
    canvasWidth,
    canvasHeight
  );

}


// ======================================================
// AI読み込み
// ======================================================

async function loadAIModel() {

  console.log(
    "COCO-SSDを読み込んでいます..."
  );

  try {

    model =
      await cocoSsd.load();

    modelReady = true;

    console.log(
      "AIモデル読み込み完了"
    );

    sendPeopleData();

    detectPeople();

  } catch (error) {

    console.error(
      "AIモデル読み込みエラー:",
      error
    );

  }

}


// ======================================================
// 人物検出
// ======================================================

async function detectPeople() {

  if (detecting) {
    return;
  }

  if (
    !modelReady ||
    !cameraReady ||
    !video ||
    !video.elt
  ) {
    return;
  }

  detecting = true;

  try {

    predictions =
      await model.detect(
        video.elt
      );

    const persons = [];

    // ==================================================
    // 人物だけ抽出
    // ==================================================

    for (
      let i = 0;
      i < predictions.length;
      i++
    ) {

      const prediction =
        predictions[i];

      if (
        prediction.class === "person" &&
        prediction.score >= PERSON_CONFIDENCE
      ) {

        persons.push(
          prediction
        );

      }

    }


    // ==================================================
    // カメラ内人数
    // ==================================================

    visiblePeopleCount =
      persons.length;


    // ==================================================
    // 人物追跡
    // ==================================================

    updateTracks(
      persons
    );


    // ==================================================
    // Firebase
    // ==================================================

    sendPeopleData();

  } catch (error) {

    console.error(
      "AI認識エラー:",
      error
    );

  }

  detecting = false;

}


// ======================================================
// 人物追跡
// ======================================================

function updateTracks(persons) {

  const now =
    Date.now();

  const detections = [];

  // ==================================================
  // 検出人物を中心座標へ変換
  // ==================================================

  for (
    let i = 0;
    i < persons.length;
    i++
  ) {

    const bbox =
      persons[i].bbox;

    const centerX =
      bbox[0] +
      bbox[2] / 2;

    const centerY =
      bbox[1] +
      bbox[3] / 2;

    detections.push({

      prediction:
        persons[i],

      x:
        centerX,

      y:
        centerY,

      matched:
        false

    });

  }


  // ==================================================
  // 既存人物との照合
  // ==================================================

  for (
    let i = 0;
    i < tracks.length;
    i++
  ) {

    const track =
      tracks[i];

    let bestDetection =
      null;

    let bestDistance =
      MATCH_DISTANCE;

    for (
      let j = 0;
      j < detections.length;
      j++
    ) {

      const detection =
        detections[j];

      if (
        detection.matched
      ) {
        continue;
      }

      const missed = track.missedFrames || 0;
      // ★速度が未定義でも追跡できるようにする
      const vx =
        track.velocityX || 0;
      const vy =
        track.velocityY || 0;

      const predictedX =
        track.x + vx * Math.min(missed + 1, 3);
      const predictedY =
        track.y + vy * Math.min(missed + 1, 3);

      const dx =
        detection.x - predictedX;

      const dy =
        detection.y - predictedY;

      const distance =
        Math.sqrt(
          dx * dx +
          dy * dy
        );

      if (
        distance <
        bestDistance
      ) {

        bestDistance =
          distance;

        bestDetection =
          detection;

      }

    }


    // ==================================================
    // 同じ人物
    // ==================================================

    if (bestDetection) {

      bestDetection.matched =
        true;

      const oldZone =
        getZone(
          track.x,
          track.y
        );

      const newZone =
        getZone(
          bestDetection.x,
          bestDetection.y
        );

      const previousX = track.x;
      const previousY = track.y;

      track.velocityX = bestDetection.x - previousX;
      track.velocityY = bestDetection.y - previousY;
      track.x = bestDetection.x;
      track.y = bestDetection.y;
      track.lastSeen = now;
      track.missedFrames = 0;
      track.prediction = bestDetection.prediction;

      updateZoneHistory(
        track,
        oldZone,
        newZone
      );

    }

  }


  // ==================================================
  // AIで一時的に見えなくなった人物を保持
  // ==================================================
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].lastSeen !== now) {
      tracks[i].missedFrames =
        (tracks[i].missedFrames || 0) + 1;
    }
  }

  // ==================================================
  // 新しい人物
  // ==================================================

  for (
    let i = 0;
    i < detections.length;
    i++
  ) {

    const detection =
      detections[i];

    if (
      detection.matched
    ) {
      continue;
    }

    const initialZone =
      getZone(
        detection.x,
        detection.y
      );

    tracks.push({

      id:
        nextTrackId++,

      x:
        detection.x,

      y:
        detection.y,

      lastSeen:
        now,

      prediction:
        detection.prediction,

      // ★初期速度
      velocityX:
        0,
      velocityY:
        0,

      // ★検出ロスト回数
      missedFrames:
        0,

      currentZone:
        initialZone,

      zoneHistory:
        [initialZone],

      // ----------------------------------------------
      // 入室
      // ----------------------------------------------

      inside:
        false,

      entryProgress:
        0,

      // ----------------------------------------------
      // 退出
      //
      // 0 = 通常
      // 1 = C到達
      // 2 = B通過
      // ----------------------------------------------

      exitState:
        0,

      // Cを通過したことがあるか
      passedC:
        false,

      lastCountTime:
        0,

      // 退出専用
      exitLastCAt:
        0,
      exitLastZone:
        initialZone

    });

    // ★退出専用: 新IDになった場合だけ退出状態を復元
    restoreExitStateForNewTrack(
      tracks[tracks.length - 1]
    );

  }


  // ==================================================
  // 古い人物を削除
  // ==================================================

  tracks =
    tracks.filter(
      function (track) {

        return (
          now -
          track.lastSeen
          <
          TRACK_TIMEOUT
        );

      }
    );

}


// ======================================================
// 実際のカメラ幅
// ======================================================

function getActualVideoWidth() {

  if (
    video &&
    video.elt &&
    video.elt.videoWidth > 0
  ) {

    return video.elt.videoWidth;

  }

  if (
    video &&
    video.width > 0
  ) {

    return video.width;

  }

  return 1280;

}


// ======================================================
// 実際のカメラ高さ
// ======================================================

function getActualVideoHeight() {

  if (
    video &&
    video.elt &&
    video.elt.videoHeight > 0
  ) {

    return video.elt.videoHeight;

  }

  if (
    video &&
    video.height > 0
  ) {

    return video.height;

  }

  return 720;

}


// ======================================================
// ★横方向A/B/C判定
//
// x座標で判定する
// 実際のカメラ映像の幅を基準にする
// ======================================================

function getZone(x, y, previousZone = null) {
  const actualVideoWidth = getActualVideoWidth();

  if (!actualVideoWidth || actualVideoWidth <= 0) {
    return previousZone || "A";
  }

  const ratio = Math.max(
    0,
    Math.min(1, x / actualVideoWidth)
  );

  const aEnd = ZONE_A_END;
  const bEnd = ZONE_B_END;
  const h = ZONE_HYSTERESIS;

  if (previousZone === "A" && ratio < aEnd + h) {
    return "A";
  }

  if (previousZone === "B") {
    if (ratio < aEnd - h) return "A";
    if (ratio >= bEnd + h) return "C";
    return "B";
  }

  if (previousZone === "C" && ratio >= bEnd - h) {
    return "C";
  }

  if (ratio < aEnd) return "A";
  if (ratio < bEnd) return "B";
  return "C";
}


// ======================================================
// ゾーン変更
// ======================================================

function updateZoneHistory(
  track,
  oldZone,
  newZone
) {

  // ★退出は同じゾーン内でも毎回確認する。
  // 入室は今まで通りゾーン変更時だけ。
  if (oldZone === newZone) {
    checkExit(track, oldZone, newZone);
    return;
  }

  console.log(
    "人物",
    track.id,
    ":",
    oldZone,
    "→",
    newZone
  );

  track.zoneHistory.push(newZone);

  if (track.zoneHistory.length > 10) {
    track.zoneHistory.shift();
  }

  track.currentZone = newZone;

  // ★入室部分は変更しない
  checkEntry(track, oldZone, newZone);

  // ★退出だけ改良
  checkExit(track, oldZone, newZone);
}


// ======================================================
// 入室
//
// A → B → C
// ======================================================

function checkEntry(
  track,
  oldZone,
  newZone
) {

  // すでに入室済みなら入室判定しない
  if (
    track.inside
  ) {

    return;

  }


  // ==================================================
  // A → B
  // ==================================================

  if (
    oldZone === "A" &&
    newZone === "B"
  ) {

    track.entryProgress =
      1;

    console.log(
      "人物",
      track.id,
      "A→B 入室準備"
    );

    return;

  }


  // ==================================================
  // B → A
  //
  // 入室方向から戻った
  // ==================================================

  if (
    oldZone === "B" &&
    newZone === "A"
  ) {

    track.entryProgress =
      0;

    return;

  }


  // ==================================================
  // B → C
  //
  // A→Bを確認済みなら入室
  // ==================================================

  if (
    oldZone === "B" &&
    newZone === "C" &&
    track.entryProgress === 1
  ) {

    const now =
      Date.now();

    if (
      now -
      track.lastCountTime
      <
      COUNT_COOLDOWN
    ) {

      return;

    }


    // ==================================================
    // 入室
    // ==================================================

    enteredCount++;

    currentPeopleCount =
      currentPeopleCount + 1;

    track.inside =
      true;

    track.entryProgress =
      0;

    track.exitState =
      0;

    track.passedC =
      false;

    track.lastCountTime =
      now;

    console.log(
      "================================"
    );

    console.log(
      "★ 入室"
    );

    console.log(
      "人物ID:",
      track.id
    );

    console.log(
      "A → B → C"
    );

    console.log(
      "現在人数:",
      currentPeopleCount
    );

    console.log(
      "================================"
    );

    sendPeopleData();

  }

}


// ======================================================
// 退出
//
// 条件:
// 1. inside === true
// 2. Cに到達したことがある
// 3. その後Aに到達したら退出
//
// つまり:
// C → B → A
// C → A
//
// Bが一瞬しか検出されなくても、Aに到達すれば退出。
// ======================================================

function checkExit(
  track,
  oldZone,
  newZone
) {

  // ==================================================
  // 退出専用ロジック
  // 入室判定・entryProgressには一切触れない
  // ==================================================

  if (track.inside !== true) {
    return;
  }

  const now = Date.now();
  const videoWidth = getActualVideoWidth();

  if (!videoWidth || videoWidth <= 0) {
    return;
  }

  const ratio = Math.max(
    0,
    Math.min(1, track.x / videoWidth)
  );

  // ==================================================
  // ① Cに到達したら「退出候補」として保存
  // ==================================================
  if (newZone === "C" || ratio >= ZONE_B_END) {
    track.passedC = true;
    track.exitState = 1;
    track.exitLastCAt = now;
    track.exitLastZone = "C";

    rememberExitCandidate(track);

    console.log(
      "人物",
      track.id,
      "C到達 → 退出候補を保存"
    );

    return;
  }

  // ==================================================
  // ② Cから左方向へ戻ったら退出追跡を継続
  // ==================================================
  if (track.passedC === true) {
    track.exitLastZone = newZone;

    if (
      oldZone === "C" ||
      newZone === "B"
    ) {
      track.exitState = 2;
    }

    // C到達後は、Aに着くまで候補を更新する
    rememberExitCandidate(track);
  }

  // ==================================================
  // ③ ★Aに到達したら即退出
  // C→B→A / C→A の両方に対応
  // ==================================================
  if (
    track.passedC === true &&
    ratio <= ZONE_A_END + EXIT_A_MARGIN
  ) {

    console.log(
      "================================"
    );
    console.log(
      "★ 退出確定",
      "ID:", track.id,
      "ratio:", ratio.toFixed(3),
      "経路: C→B→A / C→A"
    );
    console.log(
      "================================"
    );

    executeExit(track);
    return;
  }

  // ==================================================
  // ④ 検出が一時的に途切れても退出候補を保持
  // ==================================================
  if (
    track.passedC === true &&
    track.exitLastCAt > 0 &&
    now - track.exitLastCAt <= EXIT_RECOVERY_TIME
  ) {
    rememberExitCandidate(track);
  }
}


// ======================================================
// 退出候補を保存
//
// ★退出専用
// 入室処理には一切使用しない
// ======================================================

let exitCandidates = [];

function rememberExitCandidate(track) {

  if (track.inside !== true || track.passedC !== true) {
    return;
  }

  const now = Date.now();

  let candidate = exitCandidates.find(
    function (item) {
      return item.trackId === track.id;
    }
  );

  if (!candidate) {
    candidate = {
      trackId: track.id,
      assignedTrackId: track.id,
      x: track.x,
      y: track.y,
      inside: true,
      passedC: true,
      lastSeen: now,
      counted: false
    };

    exitCandidates.push(candidate);
  } else {
    candidate.x = track.x;
    candidate.y = track.y;
    candidate.inside = true;
    candidate.passedC = true;
    candidate.lastSeen = now;
  }

  // 古すぎる退出候補だけ削除
  exitCandidates = exitCandidates.filter(
    function (item) {
      return !item.counted &&
        now - item.lastSeen <= EXIT_RECOVERY_TIME;
    }
  );
}


// ======================================================
// 新しいtrackに退出状態を復元
//
// AIの一時的なID変更が起きても、
// 「Cまで来た入室済み人物」の状態を引き継ぐ。
//
// ★入室判定には触れない
// ======================================================

function restoreExitStateForNewTrack(track) {

  if (!track) {
    return;
  }

  const now = Date.now();
  const videoWidth = getActualVideoWidth();

  if (!videoWidth || videoWidth <= 0) {
    return;
  }

  const currentRatio = Math.max(
    0,
    Math.min(1, track.x / videoWidth)
  );

  // A/B側に新しいIDが出たときだけ復元候補にする
  if (currentRatio > ZONE_B_END + 0.02) {
    return;
  }

  let best = null;
  let bestScore = Infinity;

  for (let i = 0; i < exitCandidates.length; i++) {
    const candidate = exitCandidates[i];

    if (candidate.counted) {
      continue;
    }

    // すでに別の生存trackへ割り当て済みなら再利用しない。
    // ただし元trackが消えていれば新IDへ引き継げる。
    if (candidate.assignedTrackId != null) {
      const assignedAlive = tracks.some(
        function (item) {
          return item.id === candidate.assignedTrackId;
        }
      );
      if (assignedAlive && candidate.assignedTrackId !== track.id) {
        continue;
      }
    }

    if (!candidate.inside || !candidate.passedC) {
      continue;
    }

    if (
      now - candidate.lastSeen > EXIT_RECOVERY_TIME
    ) {
      continue;
    }

    // 退出方向なので、新しい検出が候補の現在位置より
    // 大きく右へ戻っているものは復元しない
    if (track.x > candidate.x + videoWidth * 0.12) {
      continue;
    }

    const dx = track.x - candidate.x;
    const dy = track.y - candidate.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 横方向の動きを重視したスコア
    const score =
      distance +
      Math.abs(dy) * 0.35;

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best) {
    return;
  }

  // C→Aの間でIDが変わった場合、退出に必要な状態だけ復元
  track.inside = true;
  track.passedC = true;
  track.exitState = currentRatio <= ZONE_A_END + EXIT_A_MARGIN ? 2 : 1;
  track.exitLastCAt = best.lastSeen;
  track.exitLastZone = getZone(
    track.x,
    track.y
  );

  console.log(
    "★ 退出追跡を新IDへ復元",
    "旧ID:", best.trackId,
    "新ID:", track.id,
    "zone:", track.exitLastZone
  );

  best.trackId = track.id;
  best.assignedTrackId = track.id;
  best.lastSeen = now;
  best.x = track.x;
  best.y = track.y;
}

// ======================================================
// 退出実行
// ======================================================

function executeExit(
  track
) {

  // 入室済みでなければ退出しない
  if (
    track.inside !== true
  ) {

    return;

  }

  const now =
    Date.now();

  // 二重カウント防止
  if (
    now -
    track.lastCountTime
    <
    COUNT_COOLDOWN
  ) {

    return;

  }

  exitedCount++;

  currentPeopleCount =
    Math.max(
      0,
      currentPeopleCount - 1
    );

  // ★退出済みにする
  // これにより同じ人物を繰り返し退出カウントしない
  track.inside =
    false;

  track.exitState =
    0;

  track.passedC =
    false;

  track.entryProgress =
    0;

  track.lastCountTime =
    now;

  console.log(
    "================================"
  );

  console.log(
    "★ 退出"
  );

  console.log(
    "人物ID:",
    track.id
  );

  console.log(
    "C → B → A / C → A"
  );

  console.log(
    "現在人数:",
    currentPeopleCount
  );

  console.log(
    "================================"
  );

  // ★退出候補も退出済みにする
  for (let i = 0; i < exitCandidates.length; i++) {
    if (exitCandidates[i].trackId === track.id) {
      exitCandidates[i].counted = true;
    }
  }

  exitCandidates = exitCandidates.filter(
    function (item) {
      return !item.counted;
    }
  );

  sendPeopleData();

}


// ======================================================
// Firebaseへ人数データ送信
//
// camera.html側で
// window.firebaseDB
// window.firebaseRef
// window.firebaseSet
// が用意されている前提
// ======================================================

async function sendPeopleData() {

  try {

    // Firebase初期化完了を待つ
    if (
      window.firebaseReady
    ) {

      await window.firebaseReady;

    }

    if (
      !window.firebaseDB ||
      !window.firebaseRef ||
      !window.firebaseSet
    ) {

      console.warn(
        "Firebaseがまだ利用できません"
      );

      return;

    }


    const peopleRef =
      window.firebaseRef(
        window.firebaseDB,
        "people/current"
      );


    const data = {

      peopleCount:
        currentPeopleCount,

      visiblePeopleCount:
        visiblePeopleCount,

      enteredCount:
        enteredCount,

      exitedCount:
        exitedCount,

      cameraReady:
        cameraReady,

      modelReady:
        modelReady,

      camera:
        "tablet",

      orientation:
        "horizontal-ABC",

      updatedAt:
        Date.now(),

      time:
        new Date().toLocaleTimeString(),

      resetAt:
        lastResetTime

    };


    await window.firebaseSet(
      peopleRef,
      data
    );


    console.log(
      "Firebase送信:",
      data
    );

  } catch (error) {

    console.error(
      "Firebase送信エラー:",
      error
    );

  }

}


// ======================================================
// ★リセット
//
// management.htmlから
// people/reset
// command: "reset"
// time: タイムスタンプ
//
// が送られたら実行する
// ======================================================

async function resetSystem(
  resetTime = Date.now()
) {

  console.log(
    "=============================="
  );

  console.log(
    "★ リセット命令を受信"
  );

  console.log(
    "リセット時刻:",
    resetTime
  );

  console.log(
    "=============================="
  );


  lastResetTime =
    Number(resetTime) ||
    Date.now();


  // ==================================================
  // 人数・カウンタを初期化
  // ==================================================

  visiblePeopleCount =
    0;

  enteredCount =
    0;

  exitedCount =
    0;

  currentPeopleCount =
    0;


  // ==================================================
  // 人物追跡を初期化
  // ==================================================

  tracks =
    [];

  nextTrackId =
    1;


  // ==================================================
  // AI検出結果を初期化
  // ==================================================

  predictions =
    [];


  // ==================================================
  // Firebaseへ即時反映
  // ==================================================

  try {

    await sendPeopleData();

  } catch (error) {

    console.error(
      "リセット後のFirebase送信エラー:",
      error
    );

  }


  console.log(
    "★ リセット完了"
  );

}



// ======================================================
// 追跡デバッグ表示
// ======================================================
function drawTrackDebug() {
  if (!tracks || tracks.length === 0) return;

  push();
  textAlign(LEFT, TOP);
  textSize(15);

  let y = 300;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];

    fill(255);

    text(
      "ID:" + track.id +
      "  ZONE:" + track.currentZone +
      "  inside:" + track.inside +
      "  C:" + track.passedC +
      "  miss:" + (track.missedFrames || 0),
      20,
      y
    );

    y += 22;

    if (y > height - 30) break;
  }

  pop();
}

// ======================================================
// draw
// ======================================================

function draw() {

  background(20);


  // ==================================================
  // カメラ
  // ==================================================

  if (
    cameraReady
  ) {

    drawCamera();

  } else {

    fill(255);

    textAlign(
      CENTER,
      CENTER
    );

    textSize(28);

    text(
      "背面カメラを起動しています...",
      width / 2,
      height / 2
    );

  }


  // ==================================================
  // 人物枠
  // ==================================================

  for (
    let i = 0;
    i < predictions.length;
    i++
  ) {

    const prediction =
      predictions[i];

    if (
      prediction.class === "person" &&
      prediction.score >= PERSON_CONFIDENCE
    ) {

      drawPersonBox(
        prediction
      );

    }

  }


  // ==================================================
  // ABC
  // ==================================================

  drawZones();


  // ==================================================
  // 人数
  // ==================================================

  drawPeopleCount();


  // ==================================================
  // 状態
  // ==================================================

  drawStatus();

  // 追跡状態を画面に表示
  drawTrackDebug();

  // ==================================================
  // AI
  // ==================================================

  if (
    modelReady &&
    cameraReady &&
    !detecting
  ) {

    detectPeople();

  }

}


// ======================================================
// カメラ表示
// ======================================================

function drawCamera() {

  const videoWidth =
    getActualVideoWidth();

  const videoHeight =
    getActualVideoHeight();

  if (
    !videoWidth ||
    !videoHeight
  ) {

    return;

  }


  const videoRatio =
    videoWidth /
    videoHeight;

  const canvasRatio =
    width /
    height;

  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;


  if (
    videoRatio >
    canvasRatio
  ) {

    drawHeight =
      height;

    drawWidth =
      height *
      videoRatio;

    offsetX =
      (
        width -
        drawWidth
      ) / 2;

    offsetY =
      0;

  } else {

    drawWidth =
      width;

    drawHeight =
      width /
      videoRatio;

    offsetX =
      0;

    offsetY =
      (
        height -
        drawHeight
      ) / 2;

  }


  image(
    video,
    offsetX,
    offsetY,
    drawWidth,
    drawHeight
  );

}


// ======================================================
// ★横ABC表示
// ======================================================

function drawZones() {

  // ==================================================
  // A/B境界
  // ==================================================

  stroke(
    255,
    255,
    0
  );

  strokeWeight(4);

  line(
    width * ZONE_A_END,
    0,
    width * ZONE_A_END,
    height
  );


  // ==================================================
  // B/C境界
  // ==================================================

  line(
    width * ZONE_B_END,
    0,
    width * ZONE_B_END,
    height
  );


  noStroke();


  // ==================================================
  // 上部表示
  // ==================================================

  fill(
    0,
    0,
    0,
    160
  );

  rect(
    0,
    0,
    width,
    80
  );


  // ==================================================
  // A
  // ==================================================

  fill(
    255,
    255,
    0
  );

  textAlign(
    CENTER,
    CENTER
  );

  textSize(
    Math.max(
      24,
      width * 0.025
    )
  );

  text(
    "A：入口",
    width * 0.165,
    height * 0.16
  );


  // ==================================================
  // B
  // ==================================================

  text(
    "B：中間",
    width * 0.50,
    height * 0.16
  );


  // ==================================================
  // C
  // ==================================================

  text(
    "C：出口",
    width * 0.835,
    height * 0.16
  );


  // ==================================================
  // 説明
  // ==================================================

  fill(255);

  textSize(
    Math.max(
      16,
      width * 0.018
    )
  );

  text(
    "A → B → C = 入室",
    width / 2,
    height - 45
  );

  text(
    "C → B → A / C → A = 退出",
    width / 2,
    height - 18
  );

}


// ======================================================
// 人物枠
// ======================================================

function drawPersonBox(
  prediction
) {

  const bbox =
    prediction.bbox;

  const x =
    bbox[0];

  const y =
    bbox[1];

  const w =
    bbox[2];

  const h =
    bbox[3];

  const videoWidth =
    getActualVideoWidth();

  const videoHeight =
    getActualVideoHeight();


  const scaleX =
    width /
    videoWidth;

  const scaleY =
    height /
    videoHeight;


  const drawX =
    x * scaleX;

  const drawY =
    y * scaleY;

  const drawW =
    w * scaleX;

  const drawH =
    h * scaleY;


  // ==================================================
  // 枠
  // ==================================================

  noFill();

  stroke(
    0,
    255,
    0
  );

  strokeWeight(4);

  rect(
    drawX,
    drawY,
    drawW,
    drawH
  );


  // ==================================================
  // 信頼度
  // ==================================================

  const confidence =
    Math.round(
      prediction.score * 100
    );

  noStroke();

  fill(
    0,
    0,
    0,
    180
  );

  rect(
    drawX,
    Math.max(
      0,
      drawY - 32
    ),
    160,
    32
  );

  fill(255);

  textAlign(
    LEFT,
    CENTER
  );

  textSize(16);

  text(
    "Person " +
    confidence +
    "%",
    drawX + 8,
    Math.max(
      16,
      drawY - 16
    )
  );

}


// ======================================================
// 人数表示
// ======================================================

function drawPeopleCount() {

  noStroke();

  fill(
    0,
    0,
    0,
    180
  );

  rect(
    20,
    100,
    300,
    175,
    15
  );

  fill(255);

  textAlign(
    LEFT
  );

  textSize(20);

  text(
    "AI入退室管理",
    40,
    130
  );

  textSize(34);

  text(
    "現在：" +
    currentPeopleCount +
    "人",
    40,
    175
  );

  textSize(19);

  text(
    "入室：" +
    enteredCount +
    "人",
    40,
    215
  );

  text(
    "退出：" +
    exitedCount +
    "人",
    165,
    215
  );

  textSize(16);

  text(
    "カメラ内：" +
    visiblePeopleCount +
    "人",
    40,
    245
  );

}


// ======================================================
// 状態
// ======================================================

function drawStatus() {

  textAlign(
    RIGHT
  );

  textSize(17);


  // ==================================================
  // カメラ
  // ==================================================

  if (
    cameraReady
  ) {

    fill(
      0,
      255,
      0
    );

    text(
      "Camera：背面",
      width - 20,
      30
    );

  } else {

    fill(
      255,
      100,
      100
    );

    text(
      "Camera：起動中",
      width - 20,
      30
    );

  }


  // ==================================================
  // AI
  // ==================================================

  if (
    modelReady
  ) {

    fill(
      0,
      255,
      0
    );

    text(
      "AI：高感度モード",
      width - 20,
      55
    );

  } else {

    fill(255);

    text(
      "AI：読み込み中",
      width - 20,
      55
    );

  }


  // ==================================================
  // Firebase
  // ==================================================

  if (
    window.firebaseDB
  ) {

    fill(
      0,
      255,
      0
    );

    text(
      "Firebase：接続OK",
      width - 20,
      80
    );

  } else {

    fill(
      255,
      100,
      100
    );

    text(
      "Firebase：接続待ち",
      width - 20,
      80
    );

  }

}


// ======================================================
// Firebase / management.html から呼び出すための確認
// ======================================================

console.log(
  "camera.js 完全版読み込み完了"
);

console.log(
  "ゾーン: A=左 / B=中央 / C=右"
);

console.log(
  "入室: A→B→C"
);

console.log(
  "退出: C→B→A / C→A"
);
