"use client";

/**
 * PipelinePro 컴포넌트 쇼케이스 — **개발용 경로 `/showcase`**.
 *
 * 제품 화면이 아니다. 디자인 토큰과 컴포넌트가 살아 있는지 눈으로 확인하는 용도이며
 * **프로덕션 내비게이션에서 링크하지 않는다.** 지우지도 않는다 — 토큰을 고칠 때마다
 * 전 컴포넌트를 한 화면에서 대조할 수 있는 곳이 여기뿐이다.
 *
 * 모든 기본/상태/도메인 컴포넌트의 variant · size · 상태를 눈으로 확인하기 위한 화면이다.
 * 실제 데이터는 연결하지 않는다 — 전부 하드코딩 예시다.
 *
 * 이 페이지만 `"use client"` 다. 칩 선택·체크박스·툴팁·재시도 같은 상호작용을 보여 주려면
 * 상태가 필요하기 때문이며, 컴포넌트 라이브러리 쪽은 Checkbox/Tooltip 만 클라이언트다.
 *
 * 시각은 전부 고정값을 주입한다. `new Date()` 를 쓰면 SSR/CSR 결과가 갈려
 * 하이드레이션 불일치가 난다.
 */

import {
  CalendarClock,
  Coins,
  Search,
  Swords,
  TriangleAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  BOSS_DIFFICULTIES,
  BOSS_DIFFICULTY_LABEL,
  BossCard,
  MesoAmount,
  SeatNumber,
  TimeUntil,
  WeekLabel,
} from "@/components/domain";
import {
  Button,
  Card,
  CardDescription,
  CardOverline,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  FilterChip,
  HelperText,
  Input,
  Label,
  ListItem,
  Radio,
  Skeleton,
  SkeletonGroup,
  StatusChip,
  Tooltip,
  type ButtonSize,
  type ButtonVariant,
  type StatusTone,
} from "@/components/ui";

/** 고정 기준 시각 (2026-08-17 21:30 KST). 하이드레이션 안정성을 위해 상수. */
const NOW = new Date("2026-08-17T21:30:00+09:00");
const IN_20_MIN = new Date("2026-08-17T21:50:00+09:00");
const IN_3_HOURS = new Date("2026-08-18T00:30:00+09:00");
const IN_2_DAYS = new Date("2026-08-19T22:00:00+09:00");
const PAST = new Date("2026-08-17T19:00:00+09:00");

const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  "primary",
  "secondary",
  "ghost",
  "destructive",
];
const BUTTON_SIZES: ReadonlyArray<{ size: ButtonSize; label: string }> = [
  { size: "sm", label: "Small 32px" },
  { size: "md", label: "Medium 38px" },
  { size: "lg", label: "Large 46px" },
];
const STATUS_TONES: ReadonlyArray<{ tone: StatusTone; label: string }> = [
  { tone: "done", label: "완료 (won)" },
  { tone: "soon", label: "임박 (at-risk)" },
  { tone: "failed", label: "실패 (lost)" },
];

const MESO_SAMPLES: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "카오스 검은 마법사", value: 3_200_000_000 },
  { label: "익스트림 세렌", value: 324_000_000 },
  { label: "하드 스우", value: 85_000_000 },
  { label: "노멀 루시드", value: 12_345 },
  { label: "이지 매그너스", value: 9_999 },
  { label: "노멀 벨로나 (§1.3 D4)", value: null },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-headline text-subhead text-ink">{title}</h2>
        {description ? (
          <p className="text-body-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
      <p className="w-40 shrink-0 text-caption text-ink-placeholder">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export default function ShowcasePage() {
  const [filters, setFilters] = useState<ReadonlySet<string>>(
    () => new Set(["hard"]),
  );
  const [agreed, setAgreed] = useState(false);
  const [world, setWorld] = useState("scania");
  const [selectedSeat, setSelectedSeat] = useState(2);
  const [retryCount, setRetryCount] = useState(0);

  const toggleFilter = (key: string) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-section-mobile px-4 py-section-mobile md:gap-section-tablet md:py-section-tablet lg:gap-section-desktop lg:py-section-desktop">
      <header className="flex flex-col gap-3">
        <p className="rounded-md border border-dashed border-border-strong bg-neutral-100 px-3 py-2 text-caption text-ink-label">
          <strong className="font-semibold">개발용 경로입니다.</strong> 제품
          화면이 아니며 서비스 내비게이션에서 링크되지 않습니다. 디자인 토큰과
          컴포넌트가 살아 있는지 확인하는 용도입니다.
        </p>
        <p className="text-overline uppercase text-primary">
          PipelinePro component showcase
        </p>
        <h1 className="font-headline text-headline text-ink">
          M_Schedule 디자인 시스템
        </h1>
        <p className="max-w-2xl text-body-lg text-ink-muted">
          이후 모든 화면이 올라갈 기본·상태·도메인 컴포넌트 전시장입니다. 데이터는
          연결되어 있지 않으며 전부 하드코딩된 예시입니다.
        </p>
        <WeekLabel date={NOW} />
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/">
            <Button variant="secondary">← 홈으로</Button>
          </Link>
          {/* 핵심 화면(§1.4)으로 가는 입구. 쇼케이스는 부품 전시장일 뿐이다. */}
          <Link href="/schedule">
            <Button>가능 시간 겹쳐보기 화면 열기 →</Button>
          </Link>
        </div>
      </header>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Button"
        description="Primary / Secondary / Ghost / Destructive · 32 · 38 · 46px · disabled 40%. hover 는 마우스를 올려 확인하세요. Primary 는 active 시 scale 0.98 이 걸립니다."
      >
        <Card className="flex flex-col gap-4">
          {BUTTON_VARIANTS.map((variant) => (
            <Row key={variant} label={variant}>
              {BUTTON_SIZES.map(({ size, label }) => (
                <Button key={size} variant={variant} size={size}>
                  {label}
                </Button>
              ))}
              <Button variant={variant} disabled>
                disabled
              </Button>
              <Button variant={variant}>
                <Swords aria-hidden size={16} />
                아이콘
              </Button>
            </Row>
          ))}
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Card"
        description="Default 는 hover 시 보더가 진해지고, Elevated 는 medium → large shadow 와 함께 2px 떠오릅니다."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardOverline>Default</CardOverline>
            <CardTitle>1px border · 8px radius</CardTitle>
            <CardDescription className="mt-2">
              16px 패딩. hover 시 border 가 border-strong 으로 전이합니다.
            </CardDescription>
          </Card>
          <Card variant="elevated">
            <CardOverline>Elevated</CardOverline>
            <CardTitle>medium → large shadow</CardTitle>
            <CardDescription className="mt-2">
              hover 시 translateY(-2px). 전환은 200ms 입니다.
            </CardDescription>
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Input · Label · HelperText"
        description="38px 높이, focus 시 primary 보더 + 3px ring(12%). error 와 disabled 상태를 함께 전시합니다."
      >
        <Card className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-nickname" required>
              본캐 닉네임
            </Label>
            <Input id="showcase-nickname" placeholder="예: Urepu" />
            <HelperText>계정 식별은 본캐 닉네임으로 합니다.</HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-key">NEXON Open API 키</Label>
            <Input
              id="showcase-key"
              invalid
              defaultValue="test_invalid_key"
              aria-describedby="showcase-key-help"
              className="font-mono text-code"
            />
            <HelperText id="showcase-key-help" tone="error">
              유효하지 않은 키입니다 (OPENAPI00005).
            </HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-disabled">월드 (비활성)</Label>
            <Input id="showcase-disabled" disabled defaultValue="스카니아" />
            <HelperText>월드는 캐릭터 정보에서 자동으로 채워집니다.</HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-search">보스 검색</Label>
            <Input id="showcase-search" type="search" placeholder="보스 이름" />
            <HelperText>placeholder 는 ink-placeholder 토큰입니다.</HelperText>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Checkbox · Radio"
        description="16px 박스/원, 1.5px 보더. indeterminate 와 disabled 포함."
      >
        <Card className="flex flex-col gap-4">
          <Row label="checkbox">
            <Checkbox
              label="이번 주 클리어"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <Checkbox label="선택됨" defaultChecked />
            <Checkbox label="부분 선택" indeterminate />
            <Checkbox label="비활성" disabled />
            <Checkbox label="비활성 + 선택" disabled defaultChecked />
            <Checkbox aria-label="라벨 없는 체크박스" />
          </Row>
          <Row label="radio">
            <Radio
              name="showcase-world"
              label="스카니아"
              value="scania"
              checked={world === "scania"}
              onChange={(event) => setWorld(event.target.value)}
            />
            <Radio
              name="showcase-world"
              label="루나"
              value="luna"
              checked={world === "luna"}
              onChange={(event) => setWorld(event.target.value)}
            />
            <Radio name="showcase-world-disabled" label="비활성" disabled />
            <Radio
              name="showcase-world-disabled"
              label="비활성 + 선택"
              disabled
              defaultChecked
            />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Chip"
        description="FilterChip 은 선택 상태가 토글되고, StatusChip 은 won·at-risk·lost 3색을 완료·임박·실패로 매핑합니다."
      >
        <Card className="flex flex-col gap-4">
          <Row label="filter (클릭 가능)">
            {BOSS_DIFFICULTIES.map((difficulty) => (
              <FilterChip
                key={difficulty}
                selected={filters.has(difficulty)}
                onClick={() => toggleFilter(difficulty)}
              >
                {BOSS_DIFFICULTY_LABEL[difficulty]}
              </FilterChip>
            ))}
            <FilterChip disabled>비활성</FilterChip>
          </Row>
          <Row label="status">
            {STATUS_TONES.map(({ tone, label }) => (
              <StatusChip
                key={tone}
                status={tone}
                icon={<CalendarClock aria-hidden size={14} />}
              >
                {label}
              </StatusChip>
            ))}
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="ListItem"
        description="44px 높이, 1px 구분선. 선택 항목은 좌측 2px primary 보더가 붙습니다."
      >
        <Card className="p-0">
          <ul className="overflow-hidden rounded-md">
            {[
              { seat: 1, name: "Urepu", note: "평일 21–24시" },
              { seat: 2, name: "Ryan", note: "화요일 제외 20시–" },
              { seat: 4, name: "Mocha", note: "주말만" },
            ].map((member) => (
              <ListItem
                key={member.seat}
                icon={<Users aria-hidden size={18} />}
                selected={selectedSeat === member.seat}
                onClick={() => setSelectedSeat(member.seat)}
                trailing={
                  <span className="text-caption text-ink-muted">
                    {member.note}
                  </span>
                }
              >
                <span className="inline-flex items-center gap-2">
                  <SeatNumber seatNo={member.seat} size="sm" />
                  {member.name}
                </span>
              </ListItem>
            ))}
            <ListItem icon={<Search aria-hidden size={18} />} disabled>
              비활성 항목
            </ListItem>
          </ul>
        </Card>
        <p className="text-caption text-ink-muted">
          3번이 비어 있는 것은 버그가 아닙니다 — 번호는 재배열되지 않는 안정
          식별자입니다 (§1.4).
        </p>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Tooltip"
        description="외부 의존성 없이 구현했습니다. 300ms 지연, 240px 최대 폭, Escape 로 닫힙니다. 키보드 Tab 으로도 열립니다."
      >
        <Card>
          <Row label="hover / focus">
            <Tooltip content="결정석 가격은 솔로 기준입니다. 실지급은 파티 인원으로 나눈 값입니다.">
              <Button variant="secondary" size="sm">
                <Coins aria-hidden size={14} />
                결정석 가격이란?
              </Button>
            </Tooltip>
            <Tooltip
              content="주간 초기화는 매주 목요일 00:00 KST 입니다."
              delay={0}
            >
              <Button variant="ghost" size="sm">
                지연 0ms 버전
              </Button>
            </Tooltip>
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="상태 — 로딩 · 빈 상태 · 에러"
        description="DoD(§0.3) 필수 3종. 스케줄러 응답이 비어 있는 것은 오류가 아니라 빈 상태입니다 (§1.1)."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="flex flex-col gap-3">
            <CardOverline>Loading</CardOverline>
            <SkeletonGroup label="보스 목록을 불러오는 중">
              <div className="flex items-center gap-3">
                <Skeleton shape="circle" className="size-10" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton shape="text" className="w-2/3" />
                  <Skeleton shape="text" className="w-1/3" />
                </div>
              </div>
              <Skeleton className="h-20 w-full" />
            </SkeletonGroup>
          </Card>

          <EmptyState
            icon={<Swords size={24} />}
            title="등록된 보스가 없습니다"
            description="해당 캐릭터가 그 날 접속하지 않았을 수도 있습니다. 오류가 아닙니다."
            action={<Button size="sm">보스 등록하기</Button>}
          />

          <ErrorState
            description="NEXON Open API 호출 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."
            detail={`OPENAPI00007 · 재시도 ${retryCount}회`}
            onRetry={() => setRetryCount((count) => count + 1)}
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="MesoAmount"
        description="항상 ko-KR 로케일. compact 는 한국식 축약이며 정확한 값은 title 속성에 있습니다. null 은 0 이 아니라 '미확인' 입니다 (§1.3 D4)."
      >
        <Card className="p-0">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-border text-left text-caption text-ink-muted">
                <th className="px-4 py-2.5 font-medium">보스</th>
                <th className="px-4 py-2.5 font-medium">기본</th>
                <th className="px-4 py-2.5 font-medium">compact</th>
                <th className="px-4 py-2.5 font-medium">accent / muted</th>
              </tr>
            </thead>
            <tbody>
              {MESO_SAMPLES.map((sample) => (
                <tr
                  key={sample.label}
                  className="border-b border-neutral-100 last:border-b-0"
                >
                  <td className="px-4 py-2.5 text-ink-muted">{sample.label}</td>
                  <td className="px-4 py-2.5">
                    <MesoAmount value={sample.value} suffix={false} />
                  </td>
                  <td className="px-4 py-2.5">
                    <MesoAmount value={sample.value} compact />
                  </td>
                  <td className="px-4 py-2.5">
                    <MesoAmount
                      value={sample.value}
                      compact
                      suffix={false}
                      tone="accent"
                    />
                    <span className="px-2 text-ink-placeholder">/</span>
                    <MesoAmount
                      value={sample.value}
                      compact
                      suffix={false}
                      tone="muted"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="TimeUntil"
        description="임박·지각은 red 가 아니라 tertiary orange 입니다. red 는 실패·취소 전용입니다 (§4)."
      >
        <Card className="flex flex-col gap-3">
          <Row label="여유 (upcoming)">
            <TimeUntil target={IN_2_DAYS} now={NOW} />
          </Row>
          <Row label="임박 (imminent)">
            <TimeUntil target={IN_3_HOURS} now={NOW} />
            <TimeUntil target={IN_20_MIN} now={NOW} />
          </Row>
          <Row label="지각 (overdue)">
            <TimeUntil target={PAST} now={NOW} />
          </Row>
          <Row label="아이콘 없음">
            <TimeUntil target={IN_2_DAYS} now={NOW} hideIcon />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="WeekLabel"
        description="주간 초기화는 매주 목요일 00:00 KST. 초기화 시점을 항상 함께 표시합니다."
      >
        <Card className="flex flex-col gap-3">
          <Row label="기본">
            <WeekLabel date={NOW} />
          </Row>
          <Row label="주차 키 숨김">
            <WeekLabel date={NOW} showWeekKey={false} />
          </Row>
          <Row label="다음 주">
            <WeekLabel date={new Date("2026-08-21T10:00:00+09:00")} />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="SeatNumber"
        description="참가자 번호는 대기열이 아니라 관리용 안정 식별자입니다. 누가 나가도 재배열하지 않습니다 (§1.4)."
      >
        <Card className="flex flex-col gap-3">
          <Row label="tone">
            <SeatNumber seatNo={1} />
            <SeatNumber seatNo={2} tone="primary" />
            <SeatNumber seatNo={4} tone="muted" />
            <SeatNumber seatNo={12} />
          </Row>
          <Row label="size">
            <SeatNumber seatNo={1} size="sm" />
            <SeatNumber seatNo={1} size="md" />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="BossCard"
        description="난이도는 좌측 보더 색으로 인코딩합니다 (§4). 상태(완료·임박·실패)는 칩과 시간 표기가 담당하며 보더 색을 덮지 않습니다."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <BossCard
            bossName="매그너스"
            difficulty="easy"
            scheduledAt={IN_2_DAYS}
            now={NOW}
            crystalPrice={9_999_000}
          />
          <BossCard
            bossName="루시드"
            difficulty="normal"
            scheduledAt={IN_2_DAYS}
            now={NOW}
            crystalPrice={120_000_000}
            partySize={3}
            seatNo={1}
          />
          <BossCard
            bossName="스우"
            difficulty="hard"
            scheduledAt={IN_3_HOURS}
            now={NOW}
            crystalPrice={324_000_000}
            partySize={2}
            status="soon"
            seatNo={2}
          />
          <BossCard
            bossName="검은 마법사"
            difficulty="chaos"
            scheduledAt={PAST}
            now={NOW}
            crystalPrice={3_200_000_000}
            partySize={6}
            status="done"
            seatNo={4}
          />
          <BossCard
            bossName="세렌"
            difficulty="extreme"
            scheduledAt={IN_20_MIN}
            now={NOW}
            crystalPrice={1_400_000_000}
            partySize={2}
            status="failed"
            footer={
              <Button variant="ghost" size="sm">
                다시 등록
              </Button>
            }
          />
          <BossCard
            bossName="벨로나"
            difficulty="normal"
            scheduledAt={IN_3_HOURS}
            now={NOW}
            crystalPrice={null}
            partySize={3}
            footer={
              <p className="flex items-center gap-1.5 text-caption text-tertiary">
                <TriangleAlert aria-hidden size={14} />
                가격 미확인 — 수익 합계에서 제외됩니다 (§1.3 D4).
              </p>
            }
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-caption text-ink-muted">
          Data based on NEXON Open API
        </p>
        <p className="text-caption text-ink-placeholder">
          이 화면은 컴포넌트 전시용이며 실제 게임 데이터를 조회하지 않습니다.
        </p>
      </footer>
    </main>
  );
}
