import { Fragment } from 'react';
import { CakeSlice, HeartHandshake } from 'lucide-react';
import { DirectionPicker } from '../components/DirectionPicker.jsx';
import { WEDDING_EVENTS, WEDDING_INFO } from '../data/wedding.js';

const EVENT_ICONS = {
  ceremony: HeartHandshake,
  celebration: CakeSlice,
};

function TextLines({ id, lines }) {
  return lines.map((line, index) => (
    <Fragment key={`${id}-${index}`}>
      {line}
      {index < lines.length - 1 && <br />}
    </Fragment>
  ));
}

export function WeddingDetails({ openDropdown, onCloseDropdown, onToggleDropdown }) {
  return (
    <section id="details" className="section weddingInfo">
      <div className="weddingInfoIntro">
        <p className="eyebrow">{WEDDING_INFO.eyebrow}</p>
        <p className="sectionLead">{WEDDING_INFO.lead}</p>
      </div>

      <div className="eventDetailsGrid">
        {WEDDING_EVENTS.map((event) => {
          const EventIcon = EVENT_ICONS[event.icon];
          const dropdownKey = `${event.id}Directions`;

          return (
            <article className="eventDetail" key={event.id}>
              <EventIcon className="eventIcon" size={62} strokeWidth={1.7} />
              <h3>{event.title}</h3>
              <p className="eventMeta">
                {event.date}
                <br />
                {event.time}
              </p>
              <p className="eventPlace">
                <TextLines id={`${event.id}-place`} lines={event.placeLines} />
                {event.reservePlaceLine && <br />}
              </p>
              <DirectionPicker
                dropdownId={`${event.id}-directions`}
                isOpen={openDropdown === dropdownKey}
                mapUrl={event.mapUrl}
                onClose={onCloseDropdown}
                onToggle={() => onToggleDropdown(dropdownKey)}
                placeName={event.placeName}
                wazeUrl={event.wazeUrl}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}
