import { Fragment } from 'react';
import {
  GRATITUDE_GROUPS,
  GRATITUDE_HONOR_PAIR,
  GRATITUDE_PAIRS,
} from '../data/wedding.js';
import { GratitudeNameList, GratitudePartyPair } from '../components/Gratitude.jsx';

export function GratefulHearts() {
  return (
    <section id="grateful-hearts" className="section gratefulHearts">
      <p className="eyebrow">With Grateful Hearts</p>
      <p className="sectionLead">To our families and friends who stand beside us.</p>
      <br />
      <br />
      <div className="gratitudeGroups">
        {GRATITUDE_GROUPS.map((group) => (
          <Fragment key={group.title}>
            <section className="gratitudeGroup">
              <h3>{group.title}</h3>
              <div className="gratitudePair">
                {group.columns.map((names, index) => (
                  <GratitudeNameList key={`${group.title}-${index}`} names={names} />
                ))}
              </div>
            </section>
            {group.title === 'Principal Sponsors' && (
              <GratitudePartyPair pair={GRATITUDE_HONOR_PAIR} />
            )}
          </Fragment>
        ))}
      </div>

      <div className="gratitudePartyRows">
        {GRATITUDE_PAIRS.map((pair, pairIndex) => (
          <GratitudePartyPair key={`gratitude-pair-${pairIndex}`} pair={pair} />
        ))}
      </div>
    </section>
  );
}
