import { describe, expect, it } from 'vitest'
import {
  blockResolverFromMap,
  escapeHtml,
  parseDocument,
  RenderError,
  renderBlock,
  renderDocument,
  safeHref,
} from '../src/index'

describe('html helpers', () => {
  it('escapes html-significant characters', () => {
    expect(escapeHtml(`<script>"a"&'b'`)).toBe('&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;')
  })

  it('neutralizes dangerous href schemes, passes through safe ones', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#')
    expect(safeHref('  JavaScript:alert(1)')).toBe('#')
    expect(safeHref('data:text/html,x')).toBe('#')
    expect(safeHref('https://example.com/a?b=1&c=2')).toBe('https://example.com/a?b=1&amp;c=2')
    expect(safeHref('/relative/path')).toBe('/relative/path')
  })
})

describe('renderBlock', () => {
  it('renders a hero with optional cta', () => {
    expect(
      renderBlock({
        type: 'hero',
        props: { heading: 'Hi', subheading: 'There', ctaLabel: 'Go', ctaHref: '/x' },
      }),
    ).toBe(
      '<section class="hero"><h1>Hi</h1><p class="hero__sub">There</p><a class="hero__cta" href="/x">Go</a></section>',
    )
  })

  it('omits the hero cta when only one of label/href is present', () => {
    expect(renderBlock({ type: 'hero', props: { heading: 'Hi', ctaLabel: 'Go' } })).toBe(
      '<section class="hero"><h1>Hi</h1></section>',
    )
  })

  it('escapes user text and sanitizes hrefs in rendered output', () => {
    const html = renderBlock({
      type: 'cta',
      props: { label: '<b>x</b>', href: 'javascript:alert(1)' },
    })
    expect(html).toBe('<a class="cta cta--primary" href="#">&lt;b&gt;x&lt;/b&gt;</a>')
  })

  it('applies schema defaults (cta variant)', () => {
    expect(renderBlock({ type: 'cta', props: { label: 'A', href: '/a' } })).toContain(
      'cta--primary',
    )
    expect(
      renderBlock({ type: 'cta', props: { label: 'A', href: '/a', variant: 'secondary' } }),
    ).toContain('cta--secondary')
  })

  it('passes richtext html through (trusted authoring layer)', () => {
    expect(renderBlock({ type: 'richtext', props: { html: '<p>hello</p>' } })).toBe(
      '<div class="richtext"><p>hello</p></div>',
    )
  })

  it('throws on unknown type and invalid props', () => {
    expect(() => renderBlock({ type: 'nope', props: {} })).toThrowError(RenderError)
    try {
      renderBlock({ type: 'hero', props: { heading: 123 } })
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError)
      expect((error as RenderError).code).toBe('invalid-props')
    }
  })
})

describe('renderDocument', () => {
  it('composes inline blocks in order', () => {
    const doc = {
      blocks: [
        { type: 'hero', props: { heading: 'Welcome' } },
        { type: 'cta', props: { label: 'Sign up', href: '/signup' } },
      ],
    }
    expect(renderDocument(doc)).toBe(
      '<section class="hero"><h1>Welcome</h1></section>\n' +
        '<a class="cta cta--primary" href="/signup">Sign up</a>',
    )
  })

  it('resolves ${block.key} references to reusable blocks', () => {
    const doc = parseDocument(
      JSON.stringify({ layout: 'default', blocks: ['${block.hero}', '${block.cta.signup}'] }),
    )
    const html = renderDocument(doc, {
      resolveBlock: blockResolverFromMap({
        'block.hero': { type: 'hero', props: { heading: 'Welcome back' } },
        'block.cta.signup': { type: 'cta', props: { label: 'Join', href: '/join' } },
      }),
    })
    expect(html).toBe(
      '<section class="hero"><h1>Welcome back</h1></section>\n' +
        '<a class="cta cta--primary" href="/join">Join</a>',
    )
  })

  it('wraps inner html in the selected layout shell', () => {
    const doc = { layout: 'page', blocks: [{ type: 'cta', props: { label: 'A', href: '/a' } }] }
    const html = renderDocument(doc, {
      layouts: { page: (inner) => `<main>${inner}</main>` },
    })
    expect(html).toBe('<main><a class="cta cta--primary" href="/a">A</a></main>')
  })

  it('throws on an unresolved reference', () => {
    try {
      renderDocument({ blocks: ['${block.missing}'] }, { resolveBlock: () => null })
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError)
      expect((error as RenderError).code).toBe('unresolved-ref')
    }
  })
})

describe('parseDocument', () => {
  it('rejects non-JSON and malformed documents', () => {
    expect(() => parseDocument('not json')).toThrowError(RenderError)
    expect(() => parseDocument(JSON.stringify({ blocks: 'nope' }))).toThrowError(RenderError)
  })
})
