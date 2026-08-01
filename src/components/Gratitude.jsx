export function GratitudeNameList({ names }) {
  return (
    <ul className="gratitudeNames">
      {names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
}

export function GratitudeBlock({ names, title }) {
  return (
    <section className="gratitudeBlock">
      <h3>{title}</h3>
      <GratitudeNameList names={names} />
    </section>
  );
}

export function GratitudePartyPair({ pair }) {
  return (
    <div className="gratitudePartyPair">
      {pair.map((column, columnIndex) => (
        <div className="gratitudePartyCell" key={`gratitude-party-cell-${columnIndex}`}>
          {column.map((block) => (
            <GratitudeBlock key={block.title} names={block.names} title={block.title} />
          ))}
        </div>
      ))}
    </div>
  );
}
