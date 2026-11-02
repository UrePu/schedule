/**
 * 배경 스크롤 잠금 — **창이 몇 개 열려 있든 잠금은 하나다.**
 *
 * 2026-11-02 결함: `Dialog` 가 각자 "내가 열릴 때의 `overflow`" 를 기억했다가 닫을 때 되돌렸다.
 * 일정 상세(A) 위에 캐릭터 고르기(B)가 뜨면 B 가 기억한 값은 A 가 건 `hidden` 이다. 그 상태로
 * 두 창이 **한 커밋에 사라지면** 정리 순서가 A → B 라 마지막에 `hidden` 이 복원되고, 창이
 * 하나도 없는데 페이지가 영영 스크롤되지 않는다.
 *
 * → 기억은 **처음 잠근 쪽 한 번**만, 복원은 **마지막으로 푸는 쪽 한 번**만 한다. 순서가 어떻게
 *   뒤섞여도 답이 같다.
 *
 * ⚠️ 모듈 수준 상태지만 브라우저 전용이다 — 부르는 곳이 effect 뿐이라 서버에서 돌지 않는다
 *    (§2.4 Rule 2 의 "서버 모듈 상태" 와 다른 이야기다).
 */
let lockCount = 0;
let overflowBeforeLock = "";

export function acquireScrollLock(): void {
  if (lockCount === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
}

export function releaseScrollLock(): void {
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0) document.body.style.overflow = overflowBeforeLock;
}
