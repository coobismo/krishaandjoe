import { FAQ_ITEMS } from '../data/wedding.js';

function FaqParagraph({ paragraph }) {
  if (typeof paragraph === 'string') {
    return <p>{paragraph}</p>;
  }

  return (
    <p>
      {paragraph.before}
      <a className="inlineTextLink" href={paragraph.href}>
        {paragraph.linkText}
      </a>
      {paragraph.after}
    </p>
  );
}

export function FaqSection() {
  return (
    <section id="faq" className="section faq">
      <p className="eyebrow">Must-Knows</p>
      <h2>FAQs</h2>
      {FAQ_ITEMS.map((item) => (
        <details key={item.question}>
          <summary>{item.question}</summary>
          {item.paragraphs.map((paragraph, index) => (
            <FaqParagraph key={`${item.question}-${index}`} paragraph={paragraph} />
          ))}
        </details>
      ))}
    </section>
  );
}
