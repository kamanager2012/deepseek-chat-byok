import katex from 'katex'
import { describe, expect, it } from 'vitest'

describe('KaTeX 0.19+ compatibility with MathFormula wrapper slicing', () => {
  it('wraps inline and display output with exact expected span tags', () => {
    const inlineHtml = katex.renderToString('x^2 + y^2', {
      throwOnError: true,
      strict: false,
      displayMode: false,
    })
    expect(inlineHtml.startsWith('<span class="katex">')).toBe(true)
    expect(inlineHtml.endsWith('</span>')).toBe(true)

    const displayHtml = katex.renderToString('E = mc^2', {
      throwOnError: true,
      strict: false,
      displayMode: true,
    })
    expect(displayHtml.startsWith('<span class="katex-display"><span class="katex">')).toBe(true)
    expect(displayHtml.endsWith('</span></span>')).toBe(true)
  })
})
