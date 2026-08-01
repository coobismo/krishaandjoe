import { ChevronDown } from 'lucide-react';

export function DropdownField({ name, label, value, options, isOpen, onChange, onClose, onToggle }) {
  const selectedOption = options.find((option) => option.value === value) || options[0];
  const labelId = `${name}-label`;
  const valueId = `${name}-value`;

  return (
    <div
      className={`selectField ${isOpen ? 'isOpen' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onClose();
        }
      }}
    >
      <span className="fieldLabel" id={labelId}>{label}</span>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-labelledby={`${labelId} ${valueId}`}
        className="dropdownButton"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          }
        }}
        type="button"
      >
        <span id={valueId}>{selectedOption.label}</span>
        <ChevronDown aria-hidden="true" size={18} />
      </button>

      {isOpen && (
        <div aria-labelledby={labelId} className="dropdownMenu" role="listbox">
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={`dropdownOption ${option.value === value ? 'isSelected' : ''}`}
              key={option.value}
              onClick={() => {
                onChange(name, option.value);
                onClose();
              }}
              role="option"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
