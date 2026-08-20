"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Link2,
  Search,
  UserMinus,
  UserPlus,
  UserRoundX,
  Users,
  X,
} from "lucide-react";
import { useId, useState } from "react";

import {
  Button,
  Card,
  CardOverline,
  CardTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
} from "@/components/ui";
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";

import {
  fetchFriendOverview,
  issueFriendLink,
  removeFriendship,
  respondFriendRequest,
  searchFriends,
  sendFriendRequest,
  setFriendDiscoverable,
  useFriendLink,
} from "../data/friend-queries";
import type {
  FriendOverview,
  FriendPerson,
  FriendSearchHit,
} from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 친구 — 검색 · 신청 · 수락 · 목록
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-20): *"친구기능 실제로 구현. 검색 신청 수락 목록. 전부 추가 하고 맨위에
 * 수익 옆에 친구 탭 만들어. 닉네임으로 검색 신청이 가능하지만 내 설정에 검색 거부도 있어야함.
 * 거부 시 링크로 친추 가능"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 화면 순서에 이유가 있다
 * ─────────────────────────────────────────────────────────────────────────────
 *   ① **받은 신청** — 내가 답해야 하는 것이 맨 위다. 이 화면에서 유일하게 "밀린 일"이다.
 *   ② **친구 찾기** — 이 화면에 오는 이유의 대부분.
 *   ③ **친구 목록**
 *   ④ **보낸 신청** — 기다리는 중이라 할 일이 없다. 취소만 가능하다.
 *   ⑤ **내 설정** — 검색 노출과 링크. 한 번 정하고 마는 값이라 맨 아래다.
 *
 * ★ 조작은 전부 **서버가 돌려준 화면 전체**를 캐시에 그대로 얹는다(§2.4 Rule 1).
 *   수락 한 번에 받은 신청·친구 목록이 동시에 움직이므로 조각으로 조립하면 두 목록이 잠깐
 *   어긋난 상태를 그린다.
 * ★ **낙관적 업데이트를 쓰지 않는다.** 서버가 "이미 친구였다 / 맞신청이라 바로 수락됐다"
 *   같은 결과를 돌려주는데, 화면이 미리 그리면 그 분기를 화면이 다시 판정하게 된다.
 */

/** 사람 이름 — 신원은 **본캐 닉네임**이다(§2.1). 없을 때만 표시 이름으로 물러난다. */
function personName(person: FriendPerson): string {
  return person.mainCharacterName ?? person.displayName;
}

/** 목록 한 줄의 공통 껍데기. 이름 + 월드 + 오른쪽 버튼들. */
function PersonRow({
  person,
  children,
}: {
  readonly person: FriendPerson;
  readonly children?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-body-sm font-semibold text-ink">
        {personName(person)}
        {person.mainWorldName === null ? null : (
          <span className="ml-2 text-caption font-normal text-ink-muted">
            {person.mainWorldName}
          </span>
        )}
      </span>
      {children}
    </li>
  );
}

export interface FriendsWorkspaceProps {
  /**
   * 친구 링크(`/friends?add=…`)로 들어왔을 때의 토큰.
   *
   * ★ **자동으로 추가하지 않는다.** 링크를 여는 것만으로 관계가 생기면 미리보기 크롤러나
   *   잘못 눌린 링크가 곧 친구 추가가 된다. 입력칸을 채워 두고 **마지막 한 번은 사람이**
   *   누르게 한다 — 그 한 번이 "이 사람과 친구가 되겠다"는 유일한 의사 표시다.
   */
  readonly initialToken: string | null;
}

export function FriendsWorkspace({ initialToken }: FriendsWorkspaceProps) {
  const queryClient = useQueryClient();
  const searchId = useId();
  const discoverableId = useId();
  const linkInputId = useId();

  const [queryText, setQueryText] = useState("");
  /** 실제로 검색에 쓰이는 값. 입력할 때마다 요청하지 않도록 **버튼/엔터에서만** 올린다. */
  const [submittedQuery, setSubmittedQuery] = useState("");
  /** 방금 발급한 링크. **이 화면을 벗어나면 다시 볼 수 없다**(서버는 해시만 갖는다). */
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkInput, setLinkInput] = useState(initialToken ?? "");

  const overviewQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.friends.overview()),
    queryFn: fetchFriendOverview,
  });

  const searchQuery = useQuery({
    ...dbQueryOptions(queryKeys.db.friends.search(submittedQuery)),
    queryFn: () => searchFriends(submittedQuery),
    enabled: submittedQuery.length >= 2,
  });

  /** 서버가 돌려준 화면 전체를 그대로 얹는다. 우리가 조립하지 않는다. */
  function applyOverview(overview: FriendOverview): void {
    queryClient.setQueryData(queryKeys.db.friends.overview(), overview);
    /*
      친구가 되면 **가능 시간 열람 범위가 넓어진다**(`can_view_availability`). 일정 화면의
      후보 목록·겹쳐보기가 그 즉시 달라지므로 함께 낡게 만든다 — 안 그러면 친구를 맺고도
      일정 화면에서 그 사람이 보이지 않는다.
    */
    void queryClient.invalidateQueries({ queryKey: queryKeys.db.people.root() });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.availability.root(),
    });
    // 검색 결과의 `relation` 배지도 낡는다.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.db.friends.root(),
    });
  }

  const request = useMutation({
    mutationFn: sendFriendRequest,
    onSuccess: (response) => applyOverview(response.overview),
  });
  const respond = useMutation({
    mutationFn: respondFriendRequest,
    onSuccess: (response) => applyOverview(response.overview),
  });
  const remove = useMutation({
    mutationFn: removeFriendship,
    onSuccess: (response) => applyOverview(response.overview),
  });
  const discoverable = useMutation({
    mutationFn: setFriendDiscoverable,
    onSuccess: applyOverview,
  });
  const issueLink = useMutation({
    mutationFn: issueFriendLink,
    onSuccess: (issued) => {
      setIssuedToken(issued.token);
      setCopied(false);
    },
  });
  const claimLink = useMutation({
    mutationFn: useFriendLink,
    onSuccess: (response) => {
      applyOverview(response.overview);
      setLinkInput("");
    },
  });

  const overview = overviewQuery.data;
  const mutationError =
    request.error ??
    respond.error ??
    remove.error ??
    discoverable.error ??
    issueLink.error ??
    claimLink.error;

  /** 발급된 링크의 전체 주소. 서버 주소는 브라우저가 알고 있다. */
  const linkUrl =
    issuedToken === null
      ? null
      : `${globalThis.location?.origin ?? ""}/friends?add=${issuedToken}`;

  if (overview === undefined) {
    return overviewQuery.isError ? (
      <ErrorState
        title="친구 목록을 불러오지 못했습니다"
        detail={overviewQuery.error.message}
        onRetry={() => void overviewQuery.refetch()}
      />
    ) : (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-32" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {mutationError === null ? null : (
        <ErrorState
          title="처리하지 못했습니다"
          detail={mutationError.message}
          className="py-4"
        />
      )}

      {/* ① 받은 신청 — 이 화면에서 유일하게 "내가 답해야 하는" 것이다. */}
      {overview.incoming.length === 0 ? null : (
        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <UserPlus aria-hidden size={18} className="text-primary" />
            <CardTitle className="text-body-lg">
              받은 친구 신청 {overview.incoming.length}건
            </CardTitle>
          </div>
          <ul className="flex flex-col gap-1.5">
            {overview.incoming.map((row) => (
              <PersonRow key={row.friendshipId} person={row}>
                <Button
                  size="sm"
                  disabled={respond.isPending}
                  onClick={() =>
                    respond.mutate({
                      friendshipId: row.friendshipId,
                      accept: true,
                    })
                  }
                >
                  <Check aria-hidden size={14} />
                  수락
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={respond.isPending}
                  onClick={() =>
                    respond.mutate({
                      friendshipId: row.friendshipId,
                      accept: false,
                    })
                  }
                >
                  <X aria-hidden size={14} />
                  거절
                </Button>
              </PersonRow>
            ))}
          </ul>
        </Card>
      )}

      {/* ② 친구 찾기 */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Search aria-hidden size={18} className="text-primary" />
          <CardTitle className="text-body-lg">친구 찾기</CardTitle>
        </div>

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedQuery(queryText.trim());
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor={searchId}>본캐 닉네임</Label>
            <Input
              id={searchId}
              value={queryText}
              placeholder="닉네임 앞부분"
              onChange={(event) => setQueryText(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={queryText.trim().length < 2}>
            <Search aria-hidden size={14} />
            검색
          </Button>
        </form>

        <HelperText>
          두 글자 이상 입력하세요. <strong className="font-semibold">검색 거부</strong>를
          켜 둔 사람은 결과에 나오지 않습니다 — 그런 사람은 링크로만 추가할 수 있습니다.
        </HelperText>

        {submittedQuery.length < 2 ? null : searchQuery.isPending ? (
          <Skeleton className="h-16" />
        ) : searchQuery.isError ? (
          <ErrorState
            title="검색하지 못했습니다"
            detail={searchQuery.error.message}
            onRetry={() => void searchQuery.refetch()}
            className="py-4"
          />
        ) : (searchQuery.data ?? []).length === 0 ? (
          /* 빈 결과는 오류가 아니다(§0.3). 왜 없을 수 있는지까지 말한다. */
          <p className="text-body-sm text-ink-label">
            찾는 사람이 없습니다. 닉네임을 다시 확인하거나, 상대가 검색을 꺼 두었다면
            링크를 받아 아래 &lsquo;링크로 추가&rsquo;에 붙여 넣으세요.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(searchQuery.data ?? []).map((hit) => (
              <PersonRow key={hit.userId} person={hit}>
                <SearchAction
                  hit={hit}
                  isPending={request.isPending}
                  onRequest={() => request.mutate(hit.userId)}
                />
              </PersonRow>
            ))}
          </ul>
        )}
      </Card>

      {/* ③ 친구 목록 */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Users aria-hidden size={18} className="text-primary" />
          <CardTitle className="text-body-lg">
            친구 {overview.friends.length}명
          </CardTitle>
        </div>

        {overview.friends.length === 0 ? (
          <EmptyState
            icon={<Users size={24} />}
            title="아직 친구가 없습니다"
            description="위에서 닉네임으로 찾아 신청하거나, 상대가 준 링크로 추가하세요. 친구가 되면 서로의 가능 시간이 일정 화면에 겹쳐 보입니다."
            className="py-6"
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {overview.friends.map((row) => (
              <PersonRow key={row.friendshipId} person={row}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(row.friendshipId)}
                >
                  <UserMinus aria-hidden size={14} />
                  친구 끊기
                </Button>
              </PersonRow>
            ))}
          </ul>
        )}
      </Card>

      {/* ④ 보낸 신청 — 기다리는 중이라 할 일이 없다. 취소만 가능하다. */}
      {overview.outgoing.length === 0 ? null : (
        <Card className="flex flex-col gap-3">
          <CardOverline>보낸 신청</CardOverline>
          <ul className="flex flex-col gap-1.5">
            {overview.outgoing.map((row) => (
              <PersonRow key={row.friendshipId} person={row}>
                <span className="text-caption text-ink-muted">수락 대기</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(row.friendshipId)}
                >
                  취소
                </Button>
              </PersonRow>
            ))}
          </ul>
        </Card>
      )}

      {/* ⑤ 내 설정 — 검색 노출과 링크 */}
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <UserRoundX aria-hidden size={18} className="text-primary" />
          <CardTitle className="text-body-lg">내 설정</CardTitle>
        </div>

        <label
          className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface px-3 py-2"
          htmlFor={discoverableId}
        >
          <Checkbox
            id={discoverableId}
            checked={!overview.discoverable}
            disabled={discoverable.isPending}
            onChange={(event) => discoverable.mutate(!event.target.checked)}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body-sm font-semibold text-ink">
              닉네임 검색 거부
            </span>
            <span className="text-body-sm text-ink-muted">
              켜면 다른 사람의 검색 결과에 내가 나오지 않습니다.{" "}
              <strong className="font-semibold text-ink">
                이미 맺은 친구는 그대로
              </strong>{" "}
              이고, 앞으로는 아래 링크를 건넨 사람만 나를 추가할 수 있습니다.
            </span>
          </span>
        </label>

        {/* ── 내 링크 ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-body-sm font-semibold text-ink">
              <Link2 aria-hidden size={16} className="text-primary" />내 친구 링크
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={issueLink.isPending}
              onClick={() => issueLink.mutate()}
            >
              {issuedToken === null ? "링크 만들기" : "새로 만들기"}
            </Button>
          </div>

          {linkUrl === null ? (
            <p className="text-body-sm text-ink-muted">
              누르면 링크가 만들어집니다. 받은 사람이 열면 바로 친구가 됩니다 — 검색을
              꺼 두었을 때 나를 추가할 수 있는 유일한 길입니다.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-hover-surface px-2 py-1 font-mono text-code text-ink select-all">
                  {linkUrl}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void globalThis.navigator?.clipboard
                      ?.writeText(linkUrl)
                      .then(() => setCopied(true));
                  }}
                >
                  <Copy aria-hidden size={14} />
                  {copied ? "복사됨" : "복사"}
                </Button>
              </div>
              {/*
                ⚠️ 다시 볼 수 없다는 사실을 **그 자리에서** 말한다. 서버는 해시만 갖고 있어
                   재발급이 곧 옛 링크를 죽이는 일이라, 나중에 "다시 보여 주세요"가 성립하지
                   않는다(§2.1 · 초대 링크와 같은 기조).
              */}
              <HelperText>
                이 링크는 지금만 볼 수 있습니다. 새로 만들면 이전 링크는 즉시 무효가
                됩니다.
              </HelperText>
            </>
          )}
        </div>

        {/* ── 받은 링크로 추가 ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <Label htmlFor={linkInputId}>링크로 추가</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={linkInputId}
              className="min-w-0 flex-1"
              value={linkInput}
              placeholder="받은 링크 또는 코드를 붙여 넣으세요"
              onChange={(event) => setLinkInput(event.target.value)}
            />
            <Button
              disabled={claimLink.isPending || linkInput.trim() === ""}
              onClick={() => claimLink.mutate(extractToken(linkInput))}
            >
              추가
            </Button>
          </div>
          {claimLink.data === undefined ? null : (
            <p className="text-body-sm text-ink">
              {claimLink.data.outcome === "already"
                ? `${claimLink.data.friendName} 님과는 이미 친구입니다.`
                : `${claimLink.data.friendName} 님과 친구가 됐습니다.`}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * 검색 결과 줄의 오른쪽. **관계에 따라 할 수 있는 일이 다르다.**
 *
 * 이미 친구이거나 신청이 오간 사람을 목록에서 빼지 않는 이유는 `FriendSearchHit.relation`
 * 주석에 있다 — 빼면 "왜 안 나오지?" 가 되고 화면이 답할 수 없다.
 */
function SearchAction({
  hit,
  isPending,
  onRequest,
}: {
  readonly hit: FriendSearchHit;
  readonly isPending: boolean;
  readonly onRequest: () => void;
}) {
  if (hit.relation === "friend") {
    return <span className="text-caption text-ink-muted">이미 친구</span>;
  }
  if (hit.relation === "outgoing") {
    return <span className="text-caption text-ink-muted">신청함 · 수락 대기</span>;
  }
  if (hit.relation === "incoming") {
    /*
      상대가 나에게 이미 신청해 둔 경우. 여기서 `신청` 을 누르면 서버가 **그 자리에서
      수락**하므로 버튼 이름을 사실대로 `수락` 이라고 적는다.
    */
    return (
      <Button size="sm" disabled={isPending} onClick={onRequest}>
        <Check aria-hidden size={14} />
        수락
      </Button>
    );
  }
  if (hit.relation === "blocked") {
    return <span className="text-caption text-ink-muted">추가할 수 없음</span>;
  }
  return (
    <Button size="sm" disabled={isPending} onClick={onRequest}>
      <UserPlus aria-hidden size={14} />
      친구 신청
    </Button>
  );
}

/**
 * 붙여 넣은 값에서 토큰만 꺼낸다.
 *
 * 사람들은 **주소 전체**를 붙여 넣는다(`https://…/friends?add=XXXX`). 코드만 받겠다고
 * 고집하면 그 자리에서 실패하고, 실패 이유가 "형식이 잘못됨" 이라 사용자가 할 수 있는 일이
 * 없다. 주소면 `add` 파라미터를 꺼내고, 아니면 통째로 토큰으로 본다.
 */
function extractToken(raw: string): string {
  const text = raw.trim();
  const marker = text.indexOf("add=");
  if (marker === -1) return text;
  return text.slice(marker + 4).split(/[&#\s]/)[0] ?? text;
}

/** 화면 바깥에서도 쓰는 유틸 — 링크로 들어온 방문자를 처리하는 페이지가 쓴다. */
export { extractToken as extractFriendToken };
