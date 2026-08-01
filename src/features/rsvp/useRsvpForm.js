import { useState } from 'react';
import {
  EMPTY_RSVP_FORM,
  RSVP_COPY,
  RSVP_ENDPOINT,
  RSVP_STORAGE_KEY,
} from '../../data/wedding.js';

function getLocalStorage() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function loadStoredResponses() {
  const storage = getLocalStorage();

  if (!storage) {
    return [];
  }

  try {
    const saved = storage.getItem(RSVP_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistResponses(responses) {
  const storage = getLocalStorage();

  if (!storage) {
    return;
  }

  try {
    storage.setItem(RSVP_STORAGE_KEY, JSON.stringify(responses));
  } catch {
    // Local backup is best-effort; RSVP submission should not fail if storage is unavailable.
  }
}

export function useRsvpForm() {
  const [form, setForm] = useState(EMPTY_RSVP_FORM);
  const [submission, setSubmission] = useState({ status: 'idle', message: '' });
  const [, setResponses] = useState(loadStoredResponses);
  const isAttending = form.attendance === 'yes';

  function updateFormValue(name, value) {
    setForm((current) => {
      if (name === 'attendance') {
        return {
          ...current,
          attendance: value,
          guests: value === 'yes' ? current.guests || '1' : '',
          additionalGuestNames: value === 'yes' ? current.additionalGuestNames : '',
        };
      }

      return { ...current, [name]: value };
    });
  }

  function updateField(event) {
    const { name, value } = event.target;
    updateFormValue(name, value);
  }

  function saveResponseLocally(entry) {
    setResponses((currentResponses) => {
      const updatedResponses = [entry, ...currentResponses];
      persistResponses(updatedResponses);
      return updatedResponses;
    });
  }

  async function submitRsvp(event) {
    event.preventDefault();

    const entry = {
      ...form,
      guests: isAttending ? form.guests : '',
      additionalGuestNames: isAttending ? form.additionalGuestNames : '',
      email: form.contactNumber,
      phone: form.contactNumber,
      submittedAt: new Date().toISOString(),
    };

    setSubmission({ status: 'submitting', message: '' });

    try {
      if (!RSVP_ENDPOINT) {
        throw new Error('Missing VITE_RSVP_ENDPOINT');
      }

      await fetch(RSVP_ENDPOINT, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(entry),
      });

      saveResponseLocally(entry);
      setSubmission({ status: 'success', message: RSVP_COPY.successMessage });
      setForm(EMPTY_RSVP_FORM);
    } catch {
      saveResponseLocally(entry);
      setSubmission({
        status: 'error',
        message: RSVP_ENDPOINT
          ? RSVP_COPY.endpointErrorMessage
          : RSVP_COPY.missingEndpointMessage,
      });
    }
  }

  return {
    form,
    isAttending,
    submission,
    submitRsvp,
    updateField,
    updateFormValue,
  };
}
