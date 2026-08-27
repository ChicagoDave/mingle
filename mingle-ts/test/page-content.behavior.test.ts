/**
 * Behavioral tests for wiki page sanitization and link substitution
 * (Phase 16, app/domain/pages/content.server.ts).
 *
 * The sanitizer is the module that decides what authored markup reaches
 * a reader's browser, so it is tested adversarially: each case names a
 * way markup could smuggle script or navigation past an allowlist, and
 * asserts on the rendered output rather than on the absence of a throw.
 * The substitution cases pin the legacy behaviours the module ports —
 * the `[[display|Page]]` and `[[project/Page]]` forms, the backslash
 * escape, and the guarantee that text inside <a>, <code> and <pre> is
 * never linkified.
 *
 * Pure functions with injected existence predicates: no database, and
 * none needed.
 *
 * Owner context: Wiki & Content verification.
 */
import { describe, expect, it } from "vitest";
import {
  isBlankContent,
  referencedCardNumbers,
  referencedPageIdentifiers,
  renderPageContent,
  sanitizePageContent,
  type PageRenderContext,
} from "../app/domain/pages/content.server";

/** A context where the named pages and numbered cards exist, nothing else. */
function context(
  pages: string[] = [],
  cards: number[] = [],
  projectIdentifier = "proj",
): PageRenderContext {
  const knownPages = new Set(pages.map((p) => p.toLowerCase()));
  const knownCards = new Set(cards);
  return {
    projectIdentifier,
    pageExists: (project, identifier) =>
      project === projectIdentifier && knownPages.has(identifier.toLowerCase()),
    cardExists: (_project, number) => knownCards.has(number),
  };
}

/** Renders with nothing existing — enough for markup-shape assertions. */
const render = (html: string, ctx = context()) => renderPageContent(html, ctx);

describe("sanitizePageContent — what survives", () => {
  it("keeps the formatting elements a rich editor produces", () => {
    const html =
      "<h2>Title</h2><p><strong>bold</strong> <em>italic</em> <code>x = 1</code></p>" +
      "<ul><li>one</li><li>two</li></ul><blockquote><p>quoted</p></blockquote>";
    expect(sanitizePageContent(html)).toBe(html);
  });

  it("keeps tables with their span attributes", () => {
    const html =
      '<table><thead><tr><th colspan="2">Head</th></tr></thead>' +
      "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>";
    expect(sanitizePageContent(html)).toBe(html);
  });

  it("keeps http, https, mailto, and site-relative links", () => {
    for (const href of [
      "https://example.com/x",
      "http://example.com",
      "mailto:someone@example.com",
      "/projects/proj/cards/3",
      "#anchor",
    ]) {
      expect(sanitizePageContent(`<a href="${href}">go</a>`)).toBe(
        `<a href="${href}">go</a>`,
      );
    }
  });

  it("closes an element the author left open", () => {
    expect(sanitizePageContent("<p>unclosed")).toBe("<p>unclosed</p>");
  });

  it("emits void elements self-closed and keeps following content", () => {
    expect(sanitizePageContent("<p>a<br>b</p><hr>")).toBe("<p>a<br />b</p><hr />");
  });
});

describe("sanitizePageContent — what does not survive", () => {
  it("drops a script element together with its contents", () => {
    expect(sanitizePageContent("<p>before<script>alert(1)</script>after</p>")).toBe(
      "<p>beforeafter</p>",
    );
  });

  it("drops a script whose contents contain markup-looking text", () => {
    expect(
      sanitizePageContent("<p>a<script>var x = '</p><img src=y>';</script>b</p>"),
    ).not.toContain("img");
  });

  it("drops style, iframe, object and form elements", () => {
    for (const tag of ["style", "iframe", "object", "form"]) {
      const out = sanitizePageContent(`<p>a<${tag}>x</${tag}>b</p>`);
      expect(out).not.toContain(tag);
      expect(out).toContain("ab");
    }
  });

  it("strips every event-handler attribute", () => {
    expect(sanitizePageContent('<p onclick="steal()" onmouseover="x()">hi</p>')).toBe(
      "<p>hi</p>",
    );
  });

  it("strips a javascript: href but keeps the link text", () => {
    expect(sanitizePageContent('<a href="javascript:alert(1)">click</a>')).toBe(
      "<a>click</a>",
    );
  });

  it("strips javascript: however it is cased or padded", () => {
    for (const href of [
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "jAvAsCrIpT:alert(1)",
    ]) {
      expect(sanitizePageContent(`<a href="${href}">x</a>`)).toBe("<a>x</a>");
    }
  });

  it("strips data: and protocol-relative URLs", () => {
    expect(
      sanitizePageContent('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x" />'),
    ).toBe('<img alt="x" />');
    expect(sanitizePageContent('<a href="//evil.example.com">x</a>')).toBe("<a>x</a>");
  });

  it("unwraps an unknown element, keeping the text it contained", () => {
    expect(sanitizePageContent("<custom-thing><p>kept</p></custom-thing>")).toBe(
      "<p>kept</p>",
    );
  });

  it("escapes text that looks like markup so it can never become markup", () => {
    expect(sanitizePageContent("<p>2 &lt; 3 &amp; 4 &gt; 1</p>")).toBe(
      "<p>2 &lt; 3 &amp; 4 &gt; 1</p>",
    );
    expect(sanitizePageContent("<p>a < b</p>")).toBe("<p>a &lt; b</p>");
  });

  it("neutralizes a mismatched closing tag instead of leaking it", () => {
    expect(sanitizePageContent("<p>a</div>b</p>")).toBe("<p>ab</p>");
  });

  it("drops an HTML comment, including a conditional one", () => {
    expect(sanitizePageContent("<p>a<!-- <script>x</script> -->b</p>")).toBe("<p>ab</p>");
  });

  it("survives a re-sanitize unchanged (its output is its own fixed point)", () => {
    const once = sanitizePageContent(
      '<p onclick="x()">hi<script>y()</script> <a href="javascript:z()">l</a></p>',
    );
    expect(sanitizePageContent(once)).toBe(once);
  });
});

describe("wiki link substitution", () => {
  it("links a page that exists", () => {
    expect(render("<p>[[Release Plan]]</p>", context(["Release_Plan"]))).toBe(
      '<p><a href="/projects/proj/wiki/Release_Plan">Release Plan</a></p>',
    );
  });

  it("marks a page that does not exist with the legacy class", () => {
    expect(render("<p>[[Nowhere]]</p>")).toBe(
      '<p><a href="/projects/proj/wiki/Nowhere" class="non-existent-wiki-page-link">Nowhere</a></p>',
    );
  });

  it("uses the display name from the [[display|Page]] form", () => {
    expect(render("<p>[[the plan|Release Plan]]</p>", context(["Release_Plan"]))).toBe(
      '<p><a href="/projects/proj/wiki/Release_Plan">the plan</a></p>',
    );
  });

  it("targets another project in the [[project/Page]] form", () => {
    const ctx = context([], [], "proj");
    expect(render("<p>[[other/Their Page]]</p>", ctx)).toContain(
      'href="/projects/other/wiki/Their_Page"',
    );
  });

  it("leaves a backslash-escaped link as literal text", () => {
    expect(render("<p>write \\[[Release Plan]] to link</p>")).toBe(
      "<p>write [[Release Plan]] to link</p>",
    );
  });

  it("renders an inert span for a name that could never be a page", () => {
    const out = render(`<p>[[${"z".repeat(300)}]]</p>`);
    expect(out).toContain('class="invalid-wiki-page-link"');
    expect(out).toContain("The page name is too long.");
    expect(out).not.toContain("<a ");
  });

  it("links several references in one paragraph, keeping the text between them", () => {
    expect(render("<p>[[A]] then [[B]]</p>", context(["A", "B"]))).toBe(
      '<p><a href="/projects/proj/wiki/A">A</a> then <a href="/projects/proj/wiki/B">B</a></p>',
    );
  });

  it("does not linkify inside code or pre", () => {
    expect(render("<p><code>[[Release Plan]]</code></p>", context(["Release_Plan"]))).toBe(
      "<p><code>[[Release Plan]]</code></p>",
    );
    expect(render("<pre>[[Release Plan]]</pre>", context(["Release_Plan"]))).toBe(
      "<pre>[[Release Plan]]</pre>",
    );
  });

  it("does not linkify inside an existing anchor", () => {
    expect(
      render('<a href="https://example.com">[[Release Plan]]</a>', context(["Release_Plan"])),
    ).toBe('<a href="https://example.com">[[Release Plan]]</a>');
  });

  it("escapes a page name carrying markup rather than emitting it", () => {
    const out = render("<p>[[<script>x</script>]]</p>");
    expect(out).not.toContain("<script>");
  });
});

describe("card link substitution", () => {
  it("links a card number that exists, with the legacy class", () => {
    expect(render("<p>see #12 now</p>", context([], [12]))).toBe(
      '<p>see <a href="/projects/proj/cards/12" class="card-link-12">#12</a> now</p>',
    );
  });

  it("leaves a number with no card behind it as plain text", () => {
    expect(render("<p>see #99 now</p>", context([], [12]))).toBe("<p>see #99 now</p>");
  });

  it("links a reference at the very start of a text node", () => {
    expect(render("<p>#12 is blocked</p>", context([], [12]))).toContain(
      'class="card-link-12"',
    );
  });

  it("ignores a number glued to a preceding word, like a colour", () => {
    expect(render("<p>colour ff#12 here</p>", context([], [12]))).toBe(
      "<p>colour ff#12 here</p>",
    );
  });

  it("does not linkify inside code, pre, or an existing anchor", () => {
    expect(render("<p><code>#12</code></p>", context([], [12]))).toBe(
      "<p><code>#12</code></p>",
    );
    expect(render('<a href="/x">#12</a>', context([], [12]))).toBe('<a href="/x">#12</a>');
  });

  it("links both a page and a card in the same sentence", () => {
    const out = render("<p>[[Plan]] blocks #12</p>", context(["Plan"], [12]));
    expect(out).toContain('href="/projects/proj/wiki/Plan"');
    expect(out).toContain('href="/projects/proj/cards/12"');
  });
});

describe("reference extraction", () => {
  it("reports the in-project page identifiers a body links to", () => {
    expect(
      referencedPageIdentifiers("<p>[[Release Plan]] and [[label|Other Page]]</p>").sort(),
    ).toEqual(["Other_Page", "Release_Plan"]);
  });

  it("excludes cross-project references, which resolve elsewhere", () => {
    expect(referencedPageIdentifiers("<p>[[other/Their Page]]</p>")).toEqual([]);
  });

  it("excludes references inside code and pre", () => {
    expect(referencedPageIdentifiers("<pre>[[Release Plan]]</pre>")).toEqual([]);
  });

  it("reports card numbers, de-duplicated", () => {
    expect(referencedCardNumbers("<p>#7 and #7 and #9</p>").sort()).toEqual([7, 9]);
  });

  it("reports nothing for an empty or absent body", () => {
    expect(referencedPageIdentifiers(null)).toEqual([]);
    expect(referencedCardNumbers("")).toEqual([]);
  });
});

describe("isBlankContent", () => {
  it("calls an editor's empty document blank", () => {
    for (const html of ["", "<p></p>", "<p><br /></p>", "<p>   </p>", "<p>&nbsp;</p>"]) {
      expect(isBlankContent(html)).toBe(true);
    }
    expect(isBlankContent(null)).toBe(true);
  });

  it("calls a body with text or a visible empty element non-blank", () => {
    for (const html of [
      "<p>a</p>",
      "<hr />",
      '<p><img src="/x.png" alt="x" /></p>',
      "<table><tr><td></td></tr></table>",
    ]) {
      expect(isBlankContent(html)).toBe(false);
    }
  });

  it("calls a body blank when only stripped markup made it look full", () => {
    expect(isBlankContent("<script>alert(1)</script>")).toBe(true);
  });
});

describe("renderPageContent — empty bodies", () => {
  it("renders an absent body as the empty string", () => {
    expect(renderPageContent(null, context())).toBe("");
    expect(renderPageContent("", context())).toBe("");
  });
});

describe("sanitizePageContent — character entities", () => {
  it("decodes decimal entities to text, then re-escapes what they spelled", () => {
    expect(sanitizePageContent("<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("decodes hex entities in either letter case", () => {
    expect(sanitizePageContent("<p>&#x41;&#X42;&#x2014;</p>")).toBe("<p>AB—</p>");
  });

  it("leaves an out-of-range code point as the literal text it was written as", () => {
    expect(sanitizePageContent("<p>&#x110000; &#0;</p>")).toBe(
      "<p>&amp;#x110000; &amp;#0;</p>",
    );
  });

  it("decodes an entity inside an attribute before the URL is judged safe", () => {
    expect(sanitizePageContent('<p><a href="/x?a=1&#38;b=2">q</a></p>')).toBe(
      '<p><a href="/x?a=1&amp;b=2">q</a></p>',
    );
    expect(sanitizePageContent('<p><a href="javascript&#58;alert(1)">q</a></p>')).toBe(
      "<p><a>q</a></p>",
    );
  });
});

describe("sanitizePageContent — malformed markup", () => {
  it("drops a doctype and a processing instruction, keeping what follows", () => {
    expect(sanitizePageContent("<!DOCTYPE html><p>a</p>")).toBe("<p>a</p>");
    expect(sanitizePageContent("<?php echo 1; ?><p>a</p>")).toBe("<p>a</p>");
  });

  it("drops an unterminated doctype rather than looping on it", () => {
    expect(sanitizePageContent("<p>a</p><!unterminated")).toBe("<p>a</p>");
  });

  it("treats an unterminated tag as the literal text it is", () => {
    expect(sanitizePageContent('<p>a</p><div class="x')).toBe('<p>a</p>&lt;div class=&quot;x');
  });
});
