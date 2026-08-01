import { CheckCircle2 } from 'lucide-react';
import { DropdownField } from '../components/DropdownField.jsx';
import { ATTENDANCE_OPTIONS, GUEST_OPTIONS, RSVP_COPY } from '../data/wedding.js';

export function RsvpSection({
  form,
  isAttending,
  openDropdown,
  submission,
  onCloseDropdown,
  onSubmit,
  onToggleDropdown,
  onUpdateField,
  onUpdateFormValue,
}) {
  return (
    <section id="rsvp" className="section rsvp">
      <div>
        <p className="eyebrow">{RSVP_COPY.eyebrow}</p>
        <h2>{RSVP_COPY.heading}</h2>
        <p>{RSVP_COPY.intro}</p>
        <p>
          {RSVP_COPY.alternate}{' '}
          <strong className="rsvpContactNumber">{RSVP_COPY.contactNumber}</strong>.
          {' '}
          {RSVP_COPY.alternateSuffix}
        </p>
      </div>

      <form className="rsvpForm" onSubmit={onSubmit}>
        <label>
          Full Name
          <input required name="name" value={form.name} onChange={onUpdateField} placeholder="Your name" />
        </label>

        <label>
          Contact Number
          <input required type="tel" name="contactNumber" value={form.contactNumber} onChange={onUpdateField} placeholder="09XX XXX XXXX" />
        </label>

        <DropdownField
          isOpen={openDropdown === 'attendance'}
          label="Will You Attend?"
          name="attendance"
          onChange={onUpdateFormValue}
          onClose={onCloseDropdown}
          onToggle={() => onToggleDropdown('attendance')}
          options={ATTENDANCE_OPTIONS}
          value={form.attendance}
        />

        {isAttending && (
          <>
            <DropdownField
              isOpen={openDropdown === 'guests'}
              label="Number of Guests"
              name="guests"
              onChange={onUpdateFormValue}
              onClose={onCloseDropdown}
              onToggle={() => onToggleDropdown('guests')}
              options={GUEST_OPTIONS}
              value={form.guests}
            />

            <label className="full">
              Additional Guest Name(s), if any
              <input
                name="additionalGuestNames"
                onChange={onUpdateField}
                placeholder="Names of additional guests"
                type="text"
                value={form.additionalGuestNames}
              />
            </label>
          </>
        )}

        <label className="full">
          Message (Optional)
          <textarea
            name="message"
            value={form.message}
            onChange={onUpdateField}
            placeholder={RSVP_COPY.textareaPlaceholder}
          />
        </label>

        <button className="button primary full" type="submit" disabled={submission.status === 'submitting'}>
          {submission.status === 'submitting' ? 'Submitting...' : 'Submit RSVP'}
        </button>

        {submission.status === 'success' && (
          <p className="formMessage success"><CheckCircle2 size={18} /> {submission.message}</p>
        )}

        {submission.status === 'error' && (
          <p className="formMessage error">{submission.message}</p>
        )}
      </form>
    </section>
  );
}
