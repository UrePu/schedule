"use client";

import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button, Card, HelperText } from "@/components/ui";
import { useSessionUser } from "@/features/auth/data/auth-queries";
import { BotLinkCodeButton } from "@/features/bot/components";
import { fetchBotSetupState } from "@/features/bot/data/bot-api";
import { fetchWeeklyChecklist } from "@/features/boss-plans/data";
import { CharacterPickerTrigger } from "@/features/characters/components";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 사용 가이드 — **사이트와 봇을 어떻게 쓰는가**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"봇 처음 들어와서 적용하기까지가 조금 어려운거같음 (…) 그냥
 * 12345 순서대로 따라하면되도록"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **봇 세팅 방법은 여기 없다** — 발주자 정정(2026-08-20)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 3번을 "봇 클라이언트를 채팅방에 넣기"로 잡고 LD플레이어 · 메신저봇R · 스크립트
 * 붙여넣기까지 적었다. 그게 틀렸다:
 *
 *   *"애초에 봇은 내가 넣어주는거임. 가이드문서는 정말 말그대로 사이트 및 봇 사용 법을
 *    알려주는거지 봇 세팅 방법을 알려주는게 아니야"*
 *
 * 봇 설치와 방 페어링은 **발주자가 대신 해 준다.** 이 화면을 읽는 사람은 이미 봇이 있는
 * 방에 들어와 있고, 알고 싶은 것은 "그래서 내가 뭘 해야 이게 내 데이터를 말해 주나"다.
 * 그래서 단계는 **읽는 사람이 직접 할 수 있는 일로만** 채운다 — 남이 해 줄 일을 절차에
 * 끼워 넣으면 자기가 해야 하는 줄 알고 거기서 멈춘다.
 *
 * 그 결과 카톡 ToS 경고도 빠졌다. 봇을 돌리는 사람에게 필요한 경고이고, 여기 읽는 사람은
 * 봇을 돌리지 않는다. (경고 자체는 글루 문서 `KAKAO.md` 첫 절에 그대로 있다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 이 화면은 **설명 옆에 그 단계의 버튼**을 둔다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주자가 막힌 지점은 글이 없어서가 아니었다 — 읽고 나면 "그래서 그 코드를 어디서 받지"를
 * 찾아 다른 화면으로 가야 했다. 3번을 읽는 자리에서 3번 코드를 발급하는 것이 이 화면의
 * 전부이고, 그래서 "12345 순서대로"가 실제로 성립한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 끝난 단계는 **끝났다고 말한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 각 단계는 지금 상태를 스스로 안다(로그인 여부 · 추적 캐릭터 수 · 계정 연결 · 내 파티).
 * 체크가 붙는 이유는 장식이 아니라, **다시 열었을 때 어디부터 하면 되는지**가 보여야 하기
 * 때문이다 — 설정은 한 번에 끝나지 않고 며칠에 걸쳐 이어지는 일이다.
 *
 * ⚠️ 5번(봇 명령어 써 보기)만 **판정할 수 없다.** 방에서 일어나는 일이라 알 방법이 없다.
 *    모르는 것을 안다고 하지 않는다 — 잘못된 체크가 붙으면 사용자는 다음에 원인 모를
 *    실패를 만난다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **비로그인도 200 으로 열린다** (DoD §0.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * 가이드는 "시작하려면 뭘 해야 하나"에 답하는 화면이라, 로그인해야 볼 수 있으면 순서가
 * 거꾸로다. 조회는 세션이 있을 때만 켜고(`enabled`), 없으면 1번이 할 일로 남는다.
 */

/**
 * 방에서 쓰는 명령. **봇 `!도움말`(`bot/server/commands.ts` 의 `helpReply()`)과 같은
 * 내용이어야 한다** — 갈라지면 화면과 방이 서로 다른 말을 한다.
 *
 * 여기에는 자주 쓰는 것만 싣는다. 전체 목록은 방에서 `!도움말` 이 준다 — 화면이 봇의
 * 도움말을 통째로 복제하면 명령이 늘 때마다 두 곳을 고쳐야 하고, 그러다 한쪽이 낡는다.
 */
const BOT_COMMANDS: ReadonlyArray<{
  readonly command: string;
  readonly what: string;
}> = [
  { command: "!일정", what: "이번 주 이 방 파티의 보스 일정" },
  { command: "!일정 오늘", what: "오늘 것만. `내일` `다음주` 도 됩니다" },
  { command: "!결정석", what: "이번 주 결정석 수익 (주간·월간 따로)" },
  { command: "!숙제", what: "캐릭터별로 아직 안 한 숙제" },
  { command: "!파티", what: "내 파티 목록" },
  { command: "!분배 950 3 3%", what: "950억을 3인이 수수료 3%로 나누면 얼마인지 계산만" },
  { command: "!드랍 950 3 3%", what: "같은 계산 + 수익 원장에 기록까지" },
  { command: "!알림 09시", what: "그 시각에 그날 일정을 방에 띄웁니다" },
  { command: "!제외 0820", what: "그날 하루 통째로 빼기" },
  { command: "!도움말", what: "전체 명령 목록" },
];

/** 단계 상태. `unknown` 이 있는 것이 이 화면의 정직함이다(3번 주석). */
type StepState = "done" | "todo" | "unknown";

export function SetupGuide() {
  const user = useSessionUser();
  const isSignedIn = user !== null;

  const checklist = useQuery({
    ...dbQueryOptions(queryKeys.db.bossPlans.checklist()),
    queryFn: fetchWeeklyChecklist,
    enabled: isSignedIn,
  });

  const setup = useQuery({
    ...dbQueryOptions(queryKeys.db.bot.setup()),
    queryFn: fetchBotSetupState,
    enabled: isSignedIn,
  });

  const trackedCount = checklist.data?.characters.length ?? 0;
  const channels = setup.data?.channels ?? [];
  const linkedChannels = channels.filter((channel) => channel.linked);
  const parties = setup.data?.parties ?? [];

  /*
    조회가 아직 안 끝났으면 **"안 했다"고 단정하지 않는다.** 잠깐 todo 로 보였다가 done 이
    되면 사용자는 자기가 한 일이 사라진 줄 안다. 그래서 로딩 중에는 `unknown` 이다.
  */
  const settled = (query: { readonly isPending: boolean }, done: boolean): StepState =>
    !isSignedIn ? "todo" : query.isPending ? "unknown" : done ? "done" : "todo";

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        <Step
          no={1}
          title="넥슨 API 키로 로그인"
          state={isSignedIn ? "done" : "todo"}
          summary={
            isSignedIn
              ? `${user.mainCharacterName ?? user.displayName} 계정으로 로그인되어 있습니다.`
              : "키가 곧 로그인 수단입니다. 별도 비밀번호는 없습니다."
          }
        >
          <p className="text-body-sm text-ink-muted">
            넥슨 오픈 API 에서 키를 발급받아 홈 화면에 입력하면 계정이 만들어집니다.
            키는 그 키를 발급한 넥슨 계정의 캐릭터만 읽을 수 있으므로, 부계정이
            있으면 나중에{" "}
            <Link
              href="/etc"
              className="text-primary underline-offset-2 hover:underline"
            >
              설정
            </Link>
            에서 키를 더 등록하면 됩니다.
          </p>
          {isSignedIn ? null : (
            <div className="flex flex-wrap gap-2">
              <Link href="/">
                <Button size="sm">홈에서 로그인 →</Button>
              </Link>
              <a
                href="https://openapi.nexon.com/"
                target="_blank"
                rel="noreferrer noopener"
              >
                <Button size="sm" variant="secondary">
                  키 발급받으러 가기 ↗
                </Button>
              </a>
            </div>
          )}
        </Step>

        <Step
          no={2}
          title="추적할 캐릭터 고르기"
          state={settled(checklist, trackedCount > 0)}
          summary={
            trackedCount > 0
              ? `${String(trackedCount)}명을 추적하고 있습니다.`
              : "고른 캐릭터만 동기화합니다. 나중에 언제든 바꿀 수 있습니다."
          }
        >
          <p className="text-body-sm text-ink-muted">
            결정석 주간 12개 상한은{" "}
            <strong className="font-semibold">캐릭터마다 따로</strong> 셉니다. 그래서
            수익과 보스 현황은 여기서 고른 캐릭터를 기준으로 계산됩니다. 캐릭터 하나당
            넥슨 호출 1회를 쓰므로, 실제로 보스를 도는 캐릭터만 고르는 편이 좋습니다.
          </p>
          {isSignedIn ? (
            <CharacterPickerTrigger label="추적 캐릭터 고르기" />
          ) : (
            <HelperText>1번을 먼저 끝내야 합니다.</HelperText>
          )}
        </Step>

        <Step
          no={3}
          title="채팅방에서 내 계정 연결"
          state={settled(setup, linkedChannels.length > 0)}
          summary={
            linkedChannels.length > 0
              ? `${String(linkedChannels.length)}개 방에서 내 계정이 인식됩니다.`
              : "이걸 해야 봇이 '내' 일정과 수익을 말해 줍니다."
          }
        >
          <p className="text-body-sm text-ink-muted">
            봇은 방에서 <strong className="font-semibold">닉네임밖에 못 봅니다.</strong>{" "}
            닉네임은 언제든 바뀌므로 식별에 쓰지 않습니다. 그래서 아래에서 코드를 받아
            방에{" "}
            <code className="rounded bg-hover-surface px-1 font-mono">!연결 코드</code>{" "}
            를 입력해 &ldquo;이 방의 이 사람이 나&rdquo;라고 알려 줘야 합니다.{" "}
            <strong className="font-semibold">
              파티원 각자가 자기 코드로 한 번씩
            </strong>{" "}
            해야 합니다.
          </p>
          {isSignedIn ? (
            <BotLinkCodeButton kind="member_link" />
          ) : (
            <HelperText>1번을 먼저 끝내야 합니다.</HelperText>
          )}
          <HelperText>
            방에 봇을 넣고 방을 연결하는 일은 이미 되어 있습니다. 안 되어 있으면 방장에게
            말씀하세요.
          </HelperText>
        </Step>

        <Step
          no={4}
          title="파티를 만들고 일정 잡기"
          state={settled(setup, parties.length > 0)}
          summary={
            parties.length > 0
              ? `참여 중인 파티 ${String(parties.length)}개.`
              : "가능 시간을 겹쳐 보고 그 자리에서 보스 일정을 잡습니다."
          }
        >
          <p className="text-body-sm text-ink-muted">
            요일별 <strong className="font-semibold">반복 패턴</strong>으로 한 번만
            등록하면 됩니다 — 매주 다시 적지 않습니다. 야근이나 여행은 그 날짜를 빼는
            식으로 처리합니다. 파티원 시간을 겹쳐 보고 비는 자리에 보스를 넣으면, 그
            일정이 곧바로{" "}
            <Link href="/" className="text-primary underline-offset-2 hover:underline">
              이번 주 일정
            </Link>{" "}
            시간표에 뜹니다.
          </p>
          {isSignedIn ? (
            <div className="flex flex-wrap gap-2">
              <Link href="/schedule">
                <Button size="sm">일정 추가로 가기 →</Button>
              </Link>
              <Link href="/boss-plans">
                <Button size="sm" variant="secondary">
                  매주 갈 보스 정하기 →
                </Button>
              </Link>
            </div>
          ) : (
            <HelperText>1번을 먼저 끝내야 합니다.</HelperText>
          )}
        </Step>

        <Step
          no={5}
          title="방에서 명령어로 쓰기"
          state="unknown"
          summary="방에서 일어나는 일이라 진행 상태를 알 수 없습니다."
        >
          <p className="text-body-sm text-ink-muted">
            <code className="rounded bg-hover-surface px-1 font-mono">!</code> 로
            시작하는 말에만 반응하고, 모르는 말에는{" "}
            <strong className="font-semibold">아무 대답도 하지 않습니다</strong>(오타로
            보이면 한 줄 제안). 자주 쓰는 것부터:
          </p>
          {/*
            ★ 목록은 봇 `!도움말` 과 **같은 내용**이어야 한다. 정의처는
              `bot/server/commands.ts` 의 `helpReply()` 이고, 여기 적힌 것이 그것과
              갈라지면 화면과 방이 서로 다른 말을 한다. 새 명령을 넣을 때 두 곳을
              함께 고칠 것.
          */}
          <dl className="flex flex-col gap-1.5">
            {BOT_COMMANDS.map((entry) => (
              <div key={entry.command} className="flex flex-wrap items-baseline gap-2">
                <dt>
                  <code className="rounded bg-hover-surface px-1.5 py-0.5 font-mono text-caption text-ink">
                    {entry.command}
                  </code>
                </dt>
                <dd className="min-w-0 flex-1 text-body-sm text-ink-muted">
                  {entry.what}
                </dd>
              </div>
            ))}
          </dl>
          <HelperText>
            방에서 <code className="font-mono">!도움말</code> 을 치면 같은 목록이
            나옵니다.
          </HelperText>
        </Step>
      </ol>

      <Card className="flex flex-col gap-2">
        <h2 className="text-body-lg font-semibold text-ink">여기까지 하면 끝입니다</h2>
        <p className="text-body-sm text-ink-muted">
          이제 방에서{" "}
          <code className="rounded bg-hover-surface px-1 font-mono">!도움말</code> 을
          쳐 보세요. 알림을 받으려면 파티마다 목적지 방을 골라야 하는데, 그건{" "}
          <Link
            href="/etc"
            className="text-primary underline-offset-2 hover:underline"
          >
            설정 › 채팅방 연결
          </Link>{" "}
          에서 정합니다. 고르지 않으면 알림 없이 웹에서만 쓰는 파티이고, 그것도 정상
          상태입니다.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href="/schedule">
            <Button size="sm" variant="secondary">
              일정 잡으러 가기 →
            </Button>
          </Link>
          <Link href="/">
            <Button size="sm" variant="ghost">
              이번 주 일정 보기 →
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/*
 * ★ 여기 있던 `CopyRow`(서버 주소 복사)와 `HowTo`(접히는 절차 묶음)는 **지웠다**
 *   (2026-08-20). 둘 다 3번이 "봇 클라이언트를 채팅방에 넣기"였을 때만 쓰이던 것이고,
 *   발주자 정정으로 그 단계가 통째로 빠졌다 — *"봇은 내가 넣어주는거임"*.
 *   쓰이지 않는 컴포넌트를 남겨 두면 다음 사람이 "이 화면은 설정값을 준다"고 오해한다.
 *   되살릴 일이 생기면 커밋 이력에 그대로 있다.
 */

/**
 * 단계 한 칸.
 *
 * ★ 번호는 **면과 글자 두 채널**로 말한다. 순서가 이 화면의 전부라(발주 요구:
 *   *"그냥 12345 순서대로 따라하면되도록"*) 번호가 흐리면 화면이 목적을 잃는다.
 * ★ 완료 표시는 색 + **아이콘** + 보조기기용 글자 세 채널이다(§4 — 색 단독 금지).
 */
function Step({
  no,
  title,
  state,
  summary,
  children,
}: {
  readonly no: number;
  readonly title: string;
  readonly state: StepState;
  readonly summary: string;
  readonly children: ReactNode;
}) {
  const done = state === "done";

  return (
    <li>
      <Card
        className={cn(
          "flex flex-col gap-3 border-l-4",
          done ? "border-l-success" : "border-l-primary",
        )}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full text-body-sm font-bold tabular-nums",
              done
                ? "bg-success text-surface"
                : "bg-primary-subtle text-primary",
            )}
          >
            {done ? <Check size={16} /> : no}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-body-lg font-semibold text-ink">
              <span className="sr-only">{no}단계. </span>
              {title}
              {done ? <span className="sr-only"> (완료)</span> : null}
            </h2>
            {/*
              상태 한 줄. `unknown` 은 "안 했다"가 아니라 "모른다"라 흐리게 두고,
              끝난 단계는 초록 잉크로 그 사실을 말한다.
            */}
            {/*
              상태 한 줄. `unknown` 은 "안 했다"가 아니라 "모른다"라 흐리게 둔다.
              ★ 완료를 **초록 글자**로 말하지 않는다 — `success`(#1ca24d)는 면·아이콘용
                램프라 흰 면 위 본문에서 AA(4.5:1)에 못 미친다(§4 가독성 규칙).
                완료는 왼쪽 원의 체크와 좌측 보더가 이미 두 채널로 말하고 있다.
            */}
            <p className="text-body-sm text-ink-muted">{summary}</p>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pl-10">{children}</div>
      </Card>
    </li>
  );
}
