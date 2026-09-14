let previousCount = 0;

let entryCount = 0;

let exitCount = 0;


// ========================================
// 管理画面起動
// ========================================
window.onload = function() {

  console.log(
    "人数管理画面を起動しました"
  );

  updateManagement();

};


// ========================================
// カメラ画面からデータを受信
// ========================================
function updateManagement() {

  let data =
    localStorage.getItem(
      "AI_PEOPLE_DATA"
    );


  // データがない場合
  if (!data) {

    setTimeout(
      updateManagement,
      500
    );

    return;

  }


  let result =
    JSON.parse(data);


  let currentCount =
    result.peopleCount;


  // ====================================
  // 人数を表示
  // ====================================

  document.getElementById(
    "peopleCount"
  ).textContent =
    currentCount + "人";


  // ====================================
  // 入室・退出を計算
  // ====================================

  if (
    currentCount > previousCount
  ) {

    entryCount +=
      currentCount -
      previousCount;

  }


  if (
    currentCount < previousCount
  ) {

    exitCount +=
      previousCount -
      currentCount;

  }


  previousCount =
    currentCount;


  // ====================================
  // 入室人数
  // ====================================

  document.getElementById(
    "entryCount"
  ).textContent =
    entryCount;


  // ====================================
  // 退出人数
  // ====================================

  document.getElementById(
    "exitCount"
  ).textContent =
    exitCount;


  // ====================================
  // カメラ状態
  // ====================================

  let cameraStatus =
    document.getElementById(
      "cameraStatus"
    );


  if (result.cameraReady) {

    cameraStatus.textContent =
      "接続中";

    cameraStatus.className =
      "online";

  }

  else {

    cameraStatus.textContent =
      "未接続";

    cameraStatus.className =
      "offline";

  }


  // ====================================
  // AI状態
  // ====================================

  let aiStatus =
    document.getElementById(
      "aiStatus"
    );


  if (result.modelReady) {

    aiStatus.textContent =
      "稼働中";

    aiStatus.className =
      "online";

  }

  else {

    aiStatus.textContent =
      "読み込み中";

    aiStatus.className =
      "offline";

  }


  // ====================================
  // 更新時刻
  // ====================================

  document.getElementById(
    "updateTime"
  ).textContent =
    result.time;


  // ====================================
  // 0.5秒ごとに更新
  // ====================================

  setTimeout(
    updateManagement,
    500
  );

}