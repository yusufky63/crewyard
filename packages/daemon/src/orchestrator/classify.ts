import type { Reason, TaskKind, TaskSize } from "@crewyard/core";

// Cheap, local and deterministic task classification (PLAN.md §9 step 1). No model call happens
// here; English and Turkish keywords both count because tasks are typed in either.

export interface Classification {
  kind: TaskKind;
  size: TaskSize;
  /** The task mentions security, which adds a Security step. */
  security: boolean;
  reasons: Reason[];
}

const KIND_RULES: Array<{ kind: TaskKind; re: RegExp }> = [
  { kind: "review", re: /\b(code review|review|audit|gözden geçir\w*|incele\w*|denetle\w*)\b/i },
  { kind: "research", re: /\b(research|investigate|compare|evaluate|survey|find out|look into|araştır\w*|karşılaştır\w*|değerlendir\w*)\b/i },
  { kind: "docs", re: /\b(docs?|documentation|readme|changelog|faq|guide|dokümantasyon\w*|belgele\w*|kılavuz\w*)\b/i },
];

// Strong verbs mean the task changes code and win over the softer kinds above; generic verbs
// ("add", "write") only decide when no softer kind matched, so "add a FAQ page" stays docs.
const STRONG_CODE = /\b(fix|implement|refactor|rewrite|migrate|bug|crash|endpoint|regression|düzelt\w*|uygula\w*|hata\w*)\b/i;
const GENERIC_CODE = /\b(add|build|remove|delete|rename|write|change|update|feature|ekle\w*|yaz\w*|kaldır\w*|değiştir\w*)\b/i;
const SECURITY = /\b(security|vulnerab\w*|cve|xss|csrf|injection|secret leak|güvenlik\w*)\b/i;
const LARGE = /\b(refactor|rewrite|migrat\w*|architecture|across the|whole|every module|tüm|bütün|mimari\w*)\b/i;
const SMALL = /\b(typo|rename|small|minor|one[- ]line|copy change|tweak|küçük|ufak|yazım hatası)\b/i;

export function classifyTask(title: string, description: string, over: { kind?: TaskKind; size?: TaskSize } = {}): Classification {
  const text = `${title}\n${description}`;
  const reasons: Reason[] = [];
  const security = SECURITY.test(text);

  let kind: TaskKind;
  if (over.kind) {
    kind = over.kind;
    reasons.push({ code: "classify.explicit", params: { kind } });
  } else {
    const strong = text.match(STRONG_CODE);
    const soft = KIND_RULES.map((r) => ({ kind: r.kind, m: text.match(r.re) })).find((r) => r.m);
    const generic = text.match(GENERIC_CODE);
    const hit = strong ? { kind: "code" as const, m: strong } : soft?.m ? { kind: soft.kind, m: soft.m } : generic ? { kind: "code" as const, m: generic } : null;
    if (hit) {
      kind = hit.kind;
      reasons.push({ code: "classify.keyword", params: { keyword: hit.m[0].toLowerCase(), kind } });
    } else {
      kind = "code";
      reasons.push({ code: "classify.default", params: { kind } });
    }
  }

  let size: TaskSize;
  if (over.size) {
    size = over.size;
    reasons.push({ code: "classify.explicit", params: { size } });
  } else {
    const large = text.match(LARGE);
    const small = text.match(SMALL);
    if (large) {
      size = "L";
      reasons.push({ code: "classify.keyword", params: { keyword: large[0].toLowerCase(), size } });
    } else if (small) {
      size = "S";
      reasons.push({ code: "classify.keyword", params: { keyword: small[0].toLowerCase(), size } });
    } else {
      size = text.length > 1200 ? "L" : text.length < 120 ? "S" : "M";
      reasons.push({ code: "classify.length", params: { chars: text.length, size } });
    }
  }

  return { kind, size, security, reasons };
}
