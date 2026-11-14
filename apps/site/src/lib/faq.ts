export interface Faq {
  id: string;
  q: string;
  a: string;
  more?: { href: string; label: string };
}

/** schema.org FAQPage for a list shown on the page (search engines only use what is visible there). */
export function faqJsonLd(items: Faq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}
