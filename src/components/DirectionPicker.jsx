import { ChevronDown } from 'lucide-react';
import { GoogleMapsIcon, WazeIcon } from './AppIcons.jsx';

export function DirectionPicker({ dropdownId, placeName, mapUrl, wazeUrl, isOpen, onClose, onToggle }) {
  return (
    <div className="eventActions">
      <div
        className={`directionPicker ${isOpen ? 'isOpen' : ''}`}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            onClose();
          }
        }}
      >
        <button
          aria-controls={dropdownId}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          className="button primary compact directionButton"
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onClose();
            }
          }}
          type="button"
        >
          Directions
          <ChevronDown aria-hidden="true" size={16} />
        </button>

        {isOpen && (
          <div aria-label={`Choose navigation app for ${placeName}`} className="directionMenu" id={dropdownId} role="menu">
            <a
              aria-label={`Open ${placeName} in Waze`}
              className="directionOption"
              href={wazeUrl}
              onClick={onClose}
              target="_blank"
              rel="noreferrer"
              role="menuitem"
            >
              <WazeIcon />
              <span>Waze</span>
            </a>
            <a
              aria-label={`Open ${placeName} in Google Maps`}
              className="directionOption"
              href={mapUrl}
              onClick={onClose}
              target="_blank"
              rel="noreferrer"
              role="menuitem"
            >
              <GoogleMapsIcon />
              <span>Maps</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
