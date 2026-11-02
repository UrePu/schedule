import type {
  ParticipantCharacterEdit,
  TimetableParticipant,
} from "../types";
import type { TimetableRunAt } from "./timetable-layout";

/**
 * 일정 상세 창이 **한 묶음을 사람 단위로** 읽는 두 가지. 화면 없이 케이스로 확인할 수 있게 뽑아 뒀다.
 */

/**
 * 이 묶음에서 **그 사람의 줄을 한 번에** 본 값.
 *
 * ★ 상세 창의 한 줄은 묶음 전체를 대표하지만 판정은 런마다 있다(1보스에만 클리어가 붙어 있을
 *   수 있다). 하나라도 막히면 그 줄은 막힌다 — 일부만 바꾸면 한 블록에서 캐릭터가 갈린다.
 * ★ 런마다 명단이 다를 수 있어 **그 사람이 불참하지 않은 런만** 모은다. 서버는 그 밖의 런을 받으면
 *   전체를 거절한다. 전부 불참이면 줄 자체가 `declined` 다.
 * ★ `currentCharacterId` 는 참가 행에 **실제로 적힌 값이 묶음 전체에서 같을 때만** 있다
 *   (`RunCharacterPickerTarget.currentCharacterId` 머리말).
 */
export function participantAcrossRuns(
  runs: readonly TimetableRunAt[],
  participantId: string,
): {
  readonly runIds: readonly string[];
  readonly person: TimetableParticipant;
  readonly edit: ParticipantCharacterEdit;
  readonly currentCharacterId: string | null;
  readonly hasMixedCharacters: boolean;
} | null {
  const found = runs.flatMap((run) => {
    const person = run.participants.find(
      (candidate) => candidate.participantId === participantId,
    );
    return person === undefined ? [] : [{ runId: run.runId, person }];
  });
  const head = found[0];
  if (head === undefined) return null;

  const active = found.filter(
    (entry) => entry.person.characterEdit !== "declined",
  );
  const edits = active.map((entry) => entry.person.characterEdit);
  const edit: ParticipantCharacterEdit = edits.includes("guest")
    ? "guest"
    : active.length === 0
      ? "declined"
      : edits.includes("clear_locked")
        ? "clear_locked"
        : edits.includes("off_record_locked")
          ? "off_record_locked"
          : edits.includes("release_clear")
            ? "release_clear"
            : "open";

  /*
    ★ 빈 칸은 "다른 캐릭터" 가 아니다. A + 빈 칸은 보스마다 다른 것이 아니라 아직 안 채워진 것이고,
      "선택됨" 으로 보여 주면 눌러도 그 빈 칸이 안 채워진다. 그래서 전부 같은 값으로 **차 있을 때만**
      선택으로 그리고, 다르다고 말하는 것은 적힌 값끼리 다를 때뿐이다.
  */
  const values = active.map((entry) => entry.person.signupCharacterId);
  const written = new Set(values.flatMap((value) => (value === null ? [] : [value])));
  const only =
    written.size === 1 && !values.includes(null) ? [...written][0] : undefined;
  return {
    runIds: active.map((entry) => entry.runId),
    person: head.person,
    edit,
    currentCharacterId: only ?? null,
    hasMixedCharacters: written.size > 1,
  };
}

/** 참가 상태만 바꾸는 요청 한 건. **그 런의 캐릭터**를 그대로 실어 보낸다. */
export interface SignupEntry {
  readonly runId: string;
  readonly characterId: string;
}

/**
 * 빠지기 · 다시 참가하기가 보낼 값 — **런마다 자기 캐릭터**.
 *
 * ★ 2026-11-02 결함: 블록 첫 런의 캐릭터를 모든 런에 보냈다. 보스마다 캐릭터가 다른 묶음에서 그건
 *   "캐릭터를 바꾸는 요청" 이 되어 빠지기가 막혔다. 참가 상태를 바꾸는 일은 캐릭터를 바꾸지 않는다.
 * ★ 참가 행이 비어 있으면 화면에 보이는 그 캐릭터(파티 관리의 내 캐릭터)를 적어 넣는다. 서버가
 *   요구하는 값이고, 비어 있는 행을 채우는 것은 바꾸는 것이 아니다(`saveRunSignup`).
 * ⚠️ 어느 쪽도 없는 런은 보낼 값이 없어 뺀다. 묶음 전체에서 없으면 버튼이 이미 막혀 있다.
 */
export function signupEntriesOf(
  runs: readonly TimetableRunAt[],
  fallbackCharacterId: string | null,
): readonly SignupEntry[] {
  return runs.flatMap((run) => {
    const characterId =
      run.signupCharacterId ?? run.characterId ?? fallbackCharacterId;
    return characterId === null ? [] : [{ runId: run.runId, characterId }];
  });
}
