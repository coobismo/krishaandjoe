import { PRE_WEDDING } from '../data/wedding.js';

export function PreWedding() {
  return (
    <section id="prewedding" className="section preWedding">
      <p className="eyebrow">{PRE_WEDDING.eyebrow}</p>
      <p className="sectionLead">{PRE_WEDDING.lead}</p>
      <br />
      <div className="videoFrame">
        <video controls playsInline preload="metadata">
          <source src={PRE_WEDDING.video} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>
    </section>
  );
}
