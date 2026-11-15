import React, { useEffect, useRef, useState } from "react";
import { Check, Link2, X } from "lucide-react";

interface LinkableTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onValueChange: (next: string) => void;
  showLinkHint?: boolean;
}

function normalizeHref(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

export function LinkableTextarea({
  value,
  onValueChange,
  disabled,
  className = "",
  showLinkHint = true,
  onKeyDown,
  ...rest
}: LinkableTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });

  function openLinkPrompt() {
    if (disabled) return;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const selected = value.slice(start, end);

    // If user selected a raw URL, treat it as both text and URL
    const trimmedSel = selected.trim();
    const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(trimmedSel);

    setSelectionRange({ start, end });
    setLinkText(selected);
    setLinkUrl(looksLikeUrl ? normalizeHref(trimmedSel) : "");
    setPopoverOpen(true);
  }

  useEffect(() => {
    if (!popoverOpen) return;
    const timer = window.setTimeout(() => {
      if (linkText.trim()) {
        urlInputRef.current?.focus();
      } else {
        textInputRef.current?.focus();
      }
    }, 10);
    return () => window.clearTimeout(timer);
  }, [popoverOpen]);

  function closePopover(restoreFocus = true) {
    setPopoverOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(selectionRange.start, selectionRange.end);
      }, 10);
    }
  }

  function applyLink() {
    const href = normalizeHref(linkUrl);
    if (!href) return;
    const label = linkText.trim() || href.replace(/^mailto:/, "");
    const markdown = `[${label}](${href})`;
    const nextValue =
      value.slice(0, selectionRange.start) + markdown + value.slice(selectionRange.end);
    onValueChange(nextValue);
    setPopoverOpen(false);

    const cursorPos = selectionRange.start + markdown.length;
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursorPos, cursorPos);
    }, 15);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      openLinkPrompt();
      return;
    }
    onKeyDown?.(e);
  }

  function handlePopoverKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      applyLink();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePopover(true);
    }
  }

  return (
    <div className="space-y-1.5">
      {popoverOpen && (
        <div className="rounded-md border border-signal/40 bg-card p-2.5 shadow-sm space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
              <Link2 className="h-3.5 w-3.5 text-signal" />
              <span>Insert link (Ctrl+K)</span>
            </span>
            <button
              type="button"
              onClick={() => closePopover(true)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close link bar"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-12 items-center">
            <input
              ref={textInputRef}
              type="text"
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              onKeyDown={handlePopoverKeyDown}
              placeholder="Link text (e.g. book a call)"
              className="sm:col-span-5 h-8 rounded border border-input bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-signal"
            />
            <input
              ref={urlInputRef}
              type="text"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={handlePopoverKeyDown}
              placeholder="https://example.com"
              className="sm:col-span-5 h-8 rounded border border-input bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-signal"
            />
            <button
              type="button"
              disabled={!linkUrl.trim()}
              onClick={applyLink}
              className="sm:col-span-2 inline-flex h-8 items-center justify-center gap-1 rounded bg-signal px-2.5 text-xs font-medium text-signal-foreground hover:opacity-90 disabled:opacity-45"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Add</span>
            </button>
          </div>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={handleKeyDown}
        className={className}
        {...rest}
      />

      {showLinkHint && !disabled && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            Select text and press <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">Ctrl+K</kbd> (or <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">Cmd+K</kbd>) to add a hyperlink.
          </span>
          <button
            type="button"
            onMouseDown={(e) => {
              // Keep textarea selection intact before opening
              e.preventDefault();
            }}
            onClick={openLinkPrompt}
            className="inline-flex items-center gap-1 font-medium text-signal hover:underline shrink-0"
          >
            <Link2 className="h-3 w-3" />
            <span>Add link</span>
          </button>
        </div>
      )}
    </div>
  );
}

const DISPLAY_LINK_RE =
  /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000}|mailto:[^\s)]{1,300})\)/g;

export function RichMessageBody({ text, className = "" }: { text: string; className?: string }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  DISPLAY_LINK_RE.lastIndex = 0;
  let idx = 0;
  for (const match of text.matchAll(DISPLAY_LINK_RE)) {
    const start = match.index ?? 0;
    if (start > last) {
      nodes.push(<React.Fragment key={`t-${idx++}`}>{text.slice(last, start)}</React.Fragment>);
    }
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    nodes.push(
      <a
        key={`a-${idx++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-signal underline underline-offset-2 hover:opacity-80"
      >
        {label}
      </a>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) {
    nodes.push(<React.Fragment key={`t-${idx++}`}>{text.slice(last)}</React.Fragment>);
  }

  return (
    <div className={`whitespace-pre-wrap font-sans leading-relaxed ${className}`}>
      {nodes}
    </div>
  );
}
