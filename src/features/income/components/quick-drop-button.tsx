"use client";

import { Package } from "lucide-react";
import { useState } from "react";

import { Button, Dialog } from "@/components/ui";
import { useSessionQuery } from "@/features/auth/data/auth-queries";
import { getWeekKey } from "@/lib/time/week";
import { cn } from "@/lib/utils";

import { DropRecordForm } from "./drop-record-form";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 드랍 기록 — **상단 바에서 바로**. 카톡 `!드랍` 의 웹 판이다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주자(2026-08-19): *"드랍은 그냥 네비게이션쪽에 !드랍 과 비슷한 동작을 하는 버튼을
 * 만들고 빼버리셈."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 수익 화면의 목록에서 떼어 냈나
 * ─────────────────────────────────────────────────────────────────────────────
 * 드랍은 **보스를 돌고 나온 직후**에 적는 일이고, 그때 사용자가 보고 있는 화면이
 * 수익 탭이라는 보장이 전혀 없다. 원래 자리는 "수익 화면을 열고 → 그 줄을 찾고 → 누른다"를
 * 요구했다. 카톡에서는 그냥 `!드랍 950 3` 한 줄이면 끝난다. 그 격차가 이 버튼이 상단 바로
 * 올라온 이유다.
 *
 * ★ **폼은 이 파일이 갖고 있지 않다.** `기타 › 드랍 기록` 페이지가 같은 폼을 그리므로
 *   `DropRecordForm` 한 곳이 소유한다(2026-08-20 발주자: *"드랍 기능도 기타로 넣어줘"*).
 *   금액을 다루는 화면을 두 벌로 두면 한쪽만 고쳐지는 날이 반드시 온다.
 */

export interface QuickDropButtonProps {
  readonly className?: string;
}

/**
 * 상단 바에 붙는 진입점.
 *
 * ★ 비로그인에는 **그리지 않는다.** 드랍은 내 원장에 남는 기록이라 세션이 없으면 할 수 있는
 *   일이 없다. 눌러도 아무것도 없는 버튼을 띄우는 것은 `NAV_ROUTES.requiresAuth` 가 이미
 *   거부한 동선이고, 여기서만 다르게 굴 이유가 없다.
 */
export function QuickDropButton({ className }: QuickDropButtonProps) {
  const session = useSessionQuery();
  const [open, setOpen] = useState(false);
  /**
   * 창을 여는 순간의 주차. **렌더 중에 `new Date()` 를 읽지 않는다** — 서버 렌더와
   * 클라이언트 렌더가 다른 값을 낼 수 있는 자리이고, 이 값은 창을 열 때만 필요하다.
   */
  const [weekKey, setWeekKey] = useState<string | null>(null);

  if ((session.data?.user ?? null) === null) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className={cn("cursor-pointer", className)}
        onClick={() => {
          setWeekKey(getWeekKey(new Date()));
          setOpen(true);
        }}
      >
        <Package aria-hidden size={14} />
        드랍
      </Button>

      {weekKey === null ? null : (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="드랍 기록"
          description="판매액과 인원을 넣으면 각자 얼마를 올려야 모두 같은 금액을 갖는지 계산하고, 그 판의 수익으로 기록합니다. 카카오톡의 !드랍 과 같은 계산입니다."
        >
          <DropRecordForm
            weekKey={weekKey}
            /* 닫힌 창을 위해 이번 주 일정을 왕복할 이유가 없다. */
            enabled={open}
            onRecorded={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </Dialog>
      )}
    </>
  );
}
