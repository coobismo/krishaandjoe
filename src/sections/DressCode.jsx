import { Fragment } from 'react';
import { DRESS_CODE } from '../data/wedding.js';

function SwatchGroup({ title, swatches, className }) {
  return (
    <section className="paletteGroup">
      <h3 className="paletteTitleBold">{title}</h3>
      <div className={`swatchGrid ${className}`}>
        {swatches.map((swatch) => (
          <div className="swatchItem" key={swatch.name}>
            <span
              aria-label={swatch.name}
              className="colorSwatch"
              style={{ '--swatch-color': swatch.color }}
            />
            <span>{swatch.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DressCode() {
  return (
    <section id="dress-code" className="section dressCode">
      <p className="eyebrow">{DRESS_CODE.eyebrow}</p>
      <p className="sectionLead">
        <span>{DRESS_CODE.lead}</span>
      </p>
      <div className="dressCodeInner">
        <div className="dressCodeContent">
          <div className="attireSection">
            <div className="attireGuide" aria-label="Attire guide">
              {DRESS_CODE.attire.map((item) => (
                <section className="attireItem" key={item.title}>
                  <img
                    alt={item.alt}
                    className="attireImage"
                    src={item.image}
                  />
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </section>
              ))}
            </div>
            <p className="attireNote"><em>{DRESS_CODE.attireNote}</em></p>
          </div>

          <div className="paletteGuide">
            <SwatchGroup
              className="sponsorsSwatches"
              swatches={DRESS_CODE.sponsorColors}
              title={DRESS_CODE.sponsorPaletteTitle}
            />

            <div className="guestPaletteGroup">
              <SwatchGroup
                className="guestSwatches"
                swatches={DRESS_CODE.guestColors}
                title={DRESS_CODE.guestPaletteTitle}
              />
            </div>

            <p className="dressCodeNote"><em>{DRESS_CODE.paletteNote}</em></p>

            <div className="avoidGuide">
              <h3 className="paletteTitleBold">{DRESS_CODE.avoidTitle}</h3>
              <p>
                {DRESS_CODE.avoidItems.map((item, index) => (
                  <Fragment key={item}>
                    {item}
                    {index < DRESS_CODE.avoidItems.length - 1 && ' • '}
                  </Fragment>
                ))}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
