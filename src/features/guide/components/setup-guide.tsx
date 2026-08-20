"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

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
 * 처음 설정 가이드 — **읽는 문서가 아니라 따라 하는 화면**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"봇 처음 들어와서 적용하기까지가 조금 어려운거같음. 처음 설명에
 * 가이드문서 작성해서 (…) 실제로 가이드 문서에서도 채팅방 연결과 계정연결을 설명해주고
 * 생성도 거기서도 가능하게 해서 그냥 12345 순서대로 따라하면되도록"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 문서가 아니라 화면인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 설정 절차는 이미 글루 저장소의 `README.md` · `KAKAO.md` 에 적혀 있었다. 그런데
 * 발주자가 막힌 지점은 **글이 없어서가 아니었다** — 글을 읽고 나면 "그래서 그 코드를 어디서
 * 받지"를 찾아 다른 화면으로 가야 했고, 코드가 두 종류라 거기서 또 한 번 갈렸다.
 *
 * 그래서 이 화면은 **설명 옆에 그 단계의 버튼을 둔다.** 4번을 읽는 자리에서 4번 코드를
 * 발급하고, 5번을 읽는 자리에서 5번 코드를 발급한다. 화면을 옮기지 않는 것이 이 화면의
 * 전부이고, 그래서 "12345 순서대로"가 실제로 성립한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 끝난 단계는 **끝났다고 말한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 각 단계는 지금 상태를 스스로 안다(로그인 여부 · 추적 캐릭터 수 · 연결된 방 · 계정 연결).
 * 체크가 붙는 이유는 장식이 아니라, **다시 열었을 때 어디부터 하면 되는지**가 보여야 하기
 * 때문이다 — 설정은 한 번에 끝나지 않고 며칠에 걸쳐 이어지는 일이다.
 *
 * ⚠️ 3번(봇 클라이언트 준비)만 **판정할 수 없다.** 우리 서버 밖에서 일어나는 일이라
 *    알 방법이 없다. 모르는 것을 안다고 하지 않고 그 사실을 적는다 — 잘못된 체크가
 *    붙으면 사용자는 다음 단계에서 원인 모를 실패를 만난다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **비로그인도 200 으로 열린다** (DoD §0.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * 가이드는 "시작하려면 뭘 해야 하나"에 답하는 화면이라, 로그인해야 볼 수 있으면 순서가
 * 거꾸로다. 조회 두 개는 세션이 있을 때만 켜고(`enabled`), 없으면 1번이 할 일로 남는다.
 */

/** 단계 상태. `unknown` 이 있는 것이 이 화면의 정직함이다(3번 주석). */
type StepState = "done" | "todo" | "unknown";

export function SetupGuide() {
  const user = useSessionUser();
  const isSignedIn = user !== null;

  /*
    두 클라이언트가 똑같이 필요로 하는 유일한 설정값. **지금 보고 있는 주소를 그대로**
    쓴다 — 환경변수로 박아 두면 미리보기 배포에서 프로덕션 주소를 알려 주게 되고,
    사용자는 자기 화면과 다른 주소를 손으로 옮겨 적게 된다.
    서버 렌더에는 `window` 가 없으므로 그때는 빈 문자열이고, 하이드레이션 뒤 채워진다.
  */
  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;

  /*
    티어: db(60초). **넥슨 호출 0건** — 둘 다 우리 DB 다.
    ★ 체크리스트 키는 `/boss-status` 와 **같은 키**라, 그 화면을 먼저 봤으면 캐시가 그대로
      쓰인다(§2.4 Rule 5 — 키 팩토리가 유일한 정의처다).
  */
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
          title="봇 클라이언트를 채팅방에 넣기"
          state="unknown"
          summary="우리 서버 밖에서 하는 일이라 진행 상태를 알 수 없습니다. 둘 중 하나만 하면 됩니다."
        >
          {/*
            ⚠️ 리스크를 **먼저** 적는다. 글루 문서(`KAKAO.md`)가 첫 절에 적어 둔 것과 같은
               내용이고, 여기서 빼면 사용자가 그 사실을 모른 채 본계정으로 돌린다.
               색은 주황이다 — red 는 실패·취소 전용이고(§4), 이건 실패가 아니라 경고다.
               그리고 문장 자체는 잉크로 쓴다(주황 본문은 AA 에 못 미친다).
          */}
          <div className="flex gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
            <TriangleAlert
              aria-hidden
              size={16}
              className="mt-0.5 shrink-0 text-tertiary-ink"
            />
            <p className="text-body-sm text-ink">
              카카오톡 운영정책은 봇·매크로 이용을{" "}
              <strong className="font-semibold">명시적으로 금지</strong>합니다. 계정이
              제한될 수 있고 소유자 본계정까지 정지된 전례가 있습니다. 반드시{" "}
              <strong className="font-semibold">부계정과 전용 단말</strong>에서만
              돌리세요.{" "}
              <strong className="font-semibold">
                이 제약이 없는 텔레그램이 더 쉽습니다.
              </strong>
            </p>
          </div>

          {/*
            ★ 서버 주소는 **양쪽 클라이언트가 똑같이 필요로 하는 유일한 설정값**이라
              방식을 고르기 전에 먼저 준다. 손으로 옮겨 적다 한 글자 틀리면 자가 검사가
              "서버 연결 실패"만 말하고 원인은 안 보인다.
          */}
          <CopyRow label="서버 주소 (양쪽 공통)" value={baseUrl} />

          {/*
            두 방식을 **접어 둔다.** 한쪽만 하면 되는데 둘을 펼쳐 놓으면 12345 의 3번이
            갑자기 15줄짜리 벽이 되어, 자기가 안 할 절차까지 읽게 된다.
          */}
          <HowTo summary="텔레그램으로 하기 (권장 · 제약 없음)">
            <li>
              텔레그램에서{" "}
              <strong className="font-semibold text-ink">@BotFather</strong> 에게{" "}
              <code className="rounded bg-hover-surface px-1 font-mono">/newbot</code>{" "}
              을 보내 봇을 만들고 <strong className="font-semibold text-ink">토큰</strong>
              을 받습니다.
            </li>
            <li>
              만든 봇을 쓸 <strong className="font-semibold text-ink">그룹방에 초대</strong>
              합니다. 개인 대화가 아니라 그룹방이어야 합니다.
            </li>
            <li>
              워커(<code className="rounded bg-hover-surface px-1 font-mono">
                telegram-glue.mjs
              </code>
              )를 받아 <code className="rounded bg-hover-surface px-1 font-mono">
                glue.env
              </code>{" "}
              에 토큰과 위 서버 주소를 적습니다. Node.js 가 깔린 PC 면 됩니다.
            </li>
            <li>
              <code className="rounded bg-hover-surface px-1 font-mono">
                node telegram-glue.mjs
              </code>{" "}
              로 실행하고 켜 둡니다. 워커가 꺼져 있으면 봇은 대답하지 않습니다.
            </li>
          </HowTo>

          <HowTo summary="카카오톡으로 하기 (메신저봇R)">
            <li>
              <strong className="font-semibold text-ink">부계정을 만듭니다.</strong>{" "}
              별도 전화번호가 필요합니다. 본계정으로는 절대 돌리지 마세요.
            </li>
            <li>
              전용 안드로이드 단말을 준비합니다. 폰을 내주기 싫으면{" "}
              <strong className="font-semibold text-ink">LD플레이어</strong>(PC 에뮬레이터)
              면 충분합니다.
            </li>
            <li>
              그 단말에 <strong className="font-semibold text-ink">메신저봇R</strong> 을
              설치하고 <strong className="font-semibold text-ink">알림 접근 권한</strong>{" "}
              허용 + <strong className="font-semibold text-ink">배터리 최적화 제외</strong>
              를 켭니다. 알림을 읽어 동작하므로 알림 내용 숨김이 켜져 있으면 안 됩니다.
            </li>
            <li>
              메신저봇R 에서 새 봇을 만들고{" "}
              <code className="rounded bg-hover-surface px-1 font-mono">
                kakao-messengerbotr.js
              </code>{" "}
              내용을 통째로 붙여넣습니다.{" "}
              <strong className="font-semibold text-ink">
                LD플레이어는 클립보드 용량 제한이 있어 붙여넣기가 잘립니다
              </strong>{" "}
              — 그때는{" "}
              <code className="rounded bg-hover-surface px-1 font-mono">adb push</code>{" "}
              로 파일을 직접 넣으세요.
            </li>
            <li>
              파일 맨 위 <code className="rounded bg-hover-surface px-1 font-mono">
                CONFIG.BASE_URL
              </code>{" "}
              이 위 서버 주소와 같은지 확인합니다.
            </li>
            <li>
              컴파일하고 봇을 켠 뒤{" "}
              <strong className="font-semibold text-ink">자가 검사 로그 4줄</strong>(HMAC ·
              SHA-256 · canonicalize · 서버 연결)이 모두 통과하는지 봅니다. 하나라도
              실패하면 봇은 스스로 멈춥니다.
            </li>
            <li>
              부계정을 쓸 <strong className="font-semibold text-ink">채팅방에 초대</strong>
              합니다. 봇 단말에서 그 방 화면을 열어 두면 알림이 오지 않아 반응하지
              않습니다.
            </li>
          </HowTo>

          <HelperText>
            어느 쪽이든 서버가 보는 계약은 같습니다. 다음 4·5번은 클라이언트 종류와
            상관없이 똑같습니다.
          </HelperText>
        </Step>

        <Step
          no={4}
          title="채팅방 연결 — 방마다 최초 1회"
          state={settled(setup, channels.length > 0)}
          summary={
            channels.length > 0
              ? `연결된 방 ${String(channels.length)}개.`
              : "이 코드는 방을 서버에 붙입니다. 사람 식별과는 다릅니다."
          }
        >
          <p className="text-body-sm text-ink-muted">
            아래에서 코드를 발급한 뒤, 그 방에서{" "}
            <code className="rounded bg-hover-surface px-1 font-mono">
              !페어링 코드
            </code>{" "}
            를 입력하세요. 방 하나에 한 번만 하면 됩니다.
          </p>
          {isSignedIn ? (
            <BotLinkCodeButton kind="channel_pair" />
          ) : (
            <HelperText>1번을 먼저 끝내야 합니다.</HelperText>
          )}
          {channels.length === 0 ? null : (
            <ul className="flex flex-col gap-1">
              {channels.map((channel) => (
                <li
                  key={channel.channelId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
                >
                  <span className="text-body-sm text-ink">
                    {channel.displayName ?? "이름 미확인"}
                  </span>
                  <span
                    className={cn(
                      "text-caption",
                      channel.linked ? "text-ink-muted" : "text-tertiary-ink",
                    )}
                  >
                    {channel.linked ? "계정 연결됨" : "계정 미연결 (5번)"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Step>

        <Step
          no={5}
          title="내 계정 연결 — 사람마다 최초 1회"
          state={settled(setup, linkedChannels.length > 0)}
          summary={
            linkedChannels.length > 0
              ? `${String(linkedChannels.length)}개 방에서 내 계정이 인식됩니다.`
              : "방이 연결돼도 서버는 아직 '이 방의 이 사람이 누구인지' 모릅니다."
          }
        >
          <p className="text-body-sm text-ink-muted">
            방에서 보이는 것은 닉네임뿐인데 닉네임은 언제든 바뀌므로 식별에 쓰지
            않습니다. 그래서 각자 코드를 받아{" "}
            <code className="rounded bg-hover-surface px-1 font-mono">
              !연결 코드
            </code>{" "}
            를 입력해야{" "}
            <code className="rounded bg-hover-surface px-1 font-mono">!일정</code> ·{" "}
            <code className="rounded bg-hover-surface px-1 font-mono">!결정석</code> 이
            본인 데이터를 냅니다.{" "}
            <strong className="font-semibold">
              파티원 각자가 자기 코드로 해야 합니다.
            </strong>
          </p>
          {isSignedIn ? (
            <BotLinkCodeButton kind="member_link" />
          ) : (
            <HelperText>1번을 먼저 끝내야 합니다.</HelperText>
          )}
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

/**
 * 그대로 옮겨 적어야 하는 값 한 줄.
 *
 * ★ **복사 버튼이 있어야 한다.** 서버 주소를 손으로 옮기다 한 글자 틀리면 자가 검사가
 *   "서버 연결 실패"만 말하고 원인은 화면 어디에도 안 보인다 — 이 가이드가 없애려는
 *   바로 그 종류의 막힘이다.
 * ★ 복사 실패는 치명적이지 않다. 값이 화면에 그대로 있으므로 조용히 넘긴다
 *   (`guest-invite-dialog` 와 같은 판단).
 */
function CopyRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-overline uppercase text-ink-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 font-mono text-body-sm text-ink">
          {value === "" ? "…" : value}
        </code>
        <Button
          size="sm"
          variant="secondary"
          disabled={value === ""}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                setCopied(false);
              });
          }}
        >
          {copied ? (
            <>
              <Check aria-hidden size={14} />
              복사됨
            </>
          ) : (
            "복사"
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * 접히는 절차 묶음.
 *
 * 3번은 **둘 중 하나만** 하면 되는 단계다. 둘을 다 펼쳐 놓으면 12345 의 3번이 갑자기
 * 15줄짜리 벽이 되고, 사용자는 자기가 하지 않을 절차까지 읽으며 "이걸 다 해야 하나"
 * 하고 멈춘다. 그래서 기본은 접힘이고, 고른 쪽만 펼친다.
 *
 * `<details>` 를 쓰는 이유: 상태를 들고 있을 이유가 없고, 키보드·보조기기 동작이
 * 브라우저 기본으로 이미 옳다. 여는 장치를 직접 만들면 그것부터 다시 검증해야 한다.
 */
function HowTo({
  summary,
  children,
}: {
  readonly summary: string;
  readonly children: ReactNode;
}) {
  return (
    <details className="rounded-md border border-border bg-background">
      <summary
        className={cn(
          "cursor-pointer list-none rounded-md px-3 py-2 text-body-sm font-semibold text-ink",
          "transition duration-200 hover:bg-hover-surface",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
        )}
      >
        {summary}
      </summary>
      <ol className="flex list-decimal flex-col gap-1.5 px-3 pb-3 pl-8 text-body-sm text-ink-muted">
        {children}
      </ol>
    </details>
  );
}

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
