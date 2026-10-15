// Zod 출력 형식 → JSON 스키마. 어댑터가 구조화 출력을 강제할 때 쓴다 (6장).
import { z } from 'zod';

type Json = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

/**
 * OpenAI 엄격 모드(Codex --output-schema)용 변환.
 * 엄격 모드는 모든 속성이 required여야 하고 additionalProperties: false여야 한다.
 * 선택 속성은 "값 또는 null"로 바꾸고, 받은 뒤 dropNullOptionals로 null을 지워 Zod 검사에 넘긴다.
 */
export function toStrictJsonSchema(schema: Json): Json {
  const s: Json = { ...schema };
  // 엄격 모드가 받지 않는 제약 키워드는 뺀다. 길이·형식 검사는 받은 뒤 Zod가 한다.
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) delete s[k];
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, Json>;
    const required = new Set((s.required as string[] | undefined) ?? []);
    const next: Record<string, Json> = {};
    for (const [k, v] of Object.entries(props)) {
      const strict = toStrictJsonSchema(v);
      next[k] = required.has(k) ? strict : { anyOf: [strict, { type: 'null' }] };
    }
    s.properties = next;
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  if (s.items && typeof s.items === 'object') s.items = toStrictJsonSchema(s.items as Json);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) s[key] = (s[key] as Json[]).map(toStrictJsonSchema);
  }
  return s;
}

/** 원래 스키마에서 선택 속성이었던 자리의 null을 지운다. */
export function dropNullOptionals(value: unknown, schema: Json): unknown {
  if (Array.isArray(value)) {
    const items = schema.items as Json | undefined;
    return items ? value.map((v) => dropNullOptionals(v, items)) : value;
  }
  if (value && typeof value === 'object' && schema.properties) {
    const props = schema.properties as Record<string, Json>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null && !required.has(k)) continue;
      out[k] = props[k] ? dropNullOptionals(v, props[k]) : v;
    }
    return out;
  }
  return value;
}

/** 모델이 JSON 앞뒤에 말을 붙이거나 ```json 블록으로 감싸도 JSON만 꺼낸다. 못 꺼내면 원문을 돌려준다. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 아래에서 다시 시도 */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* 아래에서 다시 시도 */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* 원문 */
    }
  }
  return text;
}
