/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 참가자 표시 이름의 **유일한 조합 규칙** — `본캐(부캐)`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구(원문): "본캐 말고 부캐로 추가되는경우도 있어야함 그래서
 * 본캐닉네임(보스캐릭터닉네임) 해서 만약 내가 부캐 메검메 로 파티에 들어가있으면
 * 더저(메검메) 이렇게 분류가 되어야된다는뜻임"
 *
 * | 경우                        | 표시            |
 * |-----------------------------|-----------------|
 * | 정식 계정 · 본캐로 참여     | `더저`          |
 * | 정식 계정 · 부캐로 참여     | `더저(메검메)`  |
 * | 정식 계정 · 캐릭터 미지정   | `더저`          |
 * | 게스트(닉네임만)            | `콜라이제없어`  |
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 이 문자열을 **DB 에 굽지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `party_participants.display_name` 은 공개 시간표가 `app_users` 를 조인하지 않고도
 * 렌더링되게 하려고 둔 **스냅샷**이다(마이그레이션 03 주석). 거기에 `(부캐)` 를 섞어
 * 넣으면 참여 캐릭터를 바꾸는 순간 문자열이 낡고, 그때부터 화면마다 다른 이름이 보인다.
 * **저장은 그대로 두고 읽을 때 조합한다.** 그 조합이 이 파일 하나에만 있어야
 * 파티 바 · 겹쳐보기 좌측 · 런 참가자 목록 · 구성원 편집이 같은 이름을 보여 준다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 게스트에 캐릭터가 붙지 않는 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 게스트는 `app_users` 행이 없으므로 `characters` 행도 없다(FK 가 `characters.user_id`
 * 를 요구한다). 그래서 게스트는 **언제나 닉네임 하나**이고, 그 닉네임이 곧 정체성이다.
 * 승계(`claim_guest_profile`) 후에는 정식 사용자 규칙으로 자동 전환된다 — 그 함수가
 * `display_name` 을 계정 표시명으로 덮기 때문이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 공개(비로그인) 시간표에도 부캐 닉네임이 그대로 나간다
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터 닉네임은 게임 안에서도 공개되는 정보이고, 공개 파티에 부캐로 들어가 있다는
 * 사실 자체가 그 파티의 시간표를 보는 사람에게 필요한 정보다(누가 몇 번인지, 어느
 * 캐릭터로 오는지). 감출 값이었다면 애초에 `display_name` 스냅샷 자체가 공개면에
 * 나가지 못했을 것이다. 이 판단은 CLAUDE.md §2.1 의 "공개 시간표는 비로그인 열람" 과
 * 같은 결이며, 바꾸려면 여기가 아니라 **공개면 정의(`v_public_party_*`)** 를 좁혀야 한다.
 */

/**
 * 이름 조합에 필요한 최소 정보.
 *
 * `PartyMember`(파티 참여 캐릭터)와 `RunParticipant`(그 런에 데려가는 캐릭터)가 둘 다
 * 이 모양을 만족한다 — 파티엔 메검메로 있어도 특정 런만 다른 캐릭으로 나갈 수 있으므로
 * (`party_participants.character_id` 와 `run_signups.character_id` 는 별개 컬럼이다)
 * **호출하는 쪽이 그 자리에 맞는 캐릭터를 넣는다.**
 */
export interface ParticipantIdentity {
  /** ← `party_participants.display_name` (정식 사용자는 본캐 닉네임) */
  readonly displayName: string;
  /** ← `party_participants.guest_id is not null` */
  readonly isGuest: boolean;
  /** 그 자리에서 데려가는 캐릭터 이름. 미지정이면 `null`. */
  readonly characterName: string | null;
  /** 그 캐릭터가 본캐인가. ← `characters.is_main` */
  readonly isMainCharacter: boolean;
}

/**
 * 부캐로 참여 중일 때의 **부캐 닉네임**, 아니면 `null`.
 *
 * 문자열 하나로 합치기 전 단계를 따로 노출하는 이유: 화면에 따라 본캐와 부캐를 다른
 * 굵기/색으로 그리거나 각각 따로 잘라야(`truncate`) 하기 때문이다. 조합 판정이 두 벌로
 * 갈라지지 않도록 `participantLabel` 도 이 함수를 통해 답을 얻는다.
 */
export function participantAltCharacterName(
  identity: ParticipantIdentity,
): string | null {
  // 게스트는 계정도 캐릭터도 없다. 닉네임이 곧 전부다.
  if (identity.isGuest) return null;
  if (identity.characterName === null) return null;
  // 본캐로 가면 `더저(더저)` 가 되므로 붙이지 않는다.
  if (identity.isMainCharacter) return null;
  // 표시명과 같은 이름이면 괄호가 정보 없이 길이만 늘린다.
  if (identity.characterName === identity.displayName) return null;
  return identity.characterName;
}

/** `더저` 또는 `더저(메검메)`. 한 줄 텍스트가 필요한 자리(툴팁·aria-label·카톡)에 쓴다. */
export function participantLabel(identity: ParticipantIdentity): string {
  const alt = participantAltCharacterName(identity);
  return alt === null ? identity.displayName : `${identity.displayName}(${alt})`;
}
