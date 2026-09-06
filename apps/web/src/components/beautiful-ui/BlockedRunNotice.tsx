import { Monitor } from "lucide-react";
import { BuiButton, BuiCard } from "./primitives";

export function BlockedRunNotice({
  botName,
  onOpenComputer,
}: {
  botName: string;
  onOpenComputer: () => void;
}) {
  return (
    <div className="px-4 pb-2">
      <BuiCard
        role="status"
        aria-live="polite"
        data-testid="blocked-run-notice"
        className="flex items-center gap-3 border border-amber-400/35 px-4 py-3"
        style={{ background: "color-mix(in srgb, #f59e0b 9%, var(--bui-surface))" }}
      >
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-amber-500"
          style={{ background: "color-mix(in srgb, #f59e0b 14%, transparent)" }}
          aria-hidden
        >
          <Monitor size={18} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-[var(--bui-ink)]">
            {`${botName} needs you`}
          </span>
          <span className="block text-[12.5px] text-[var(--bui-ink-3)]">
            Open the computer to continue this task.
          </span>
        </span>
        <BuiButton onClick={onOpenComputer}>Open computer</BuiButton>
      </BuiCard>
    </div>
  );
}
