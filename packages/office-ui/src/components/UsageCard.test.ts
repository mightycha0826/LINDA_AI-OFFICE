import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Meter } from './UsageCard.tsx';

describe('unlimited usage display',()=>{
  it('shows inflated estimates as reference text without an exhausted progress meter',()=>{
    const html=renderToStaticMarkup(createElement(Meter,{label:'Claude 개발',used:450,limit:null}));
    expect(html).toContain('자체 제한 없음');expect(html).toContain('450%');expect(html).not.toContain('role="meter"');expect(html).not.toContain('ao-meter__bar--full');
  });
});
