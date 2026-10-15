export function postRsvp(endpoint, entry) {
  return fetch(endpoint, {
    method: 'POST',
    mode: 'no-cors',
    // Cross-origin no-cors requests require redirect: 'follow'. Apps Script
    // redirects to script.googleusercontent.com after processing the POST.
    redirect: 'follow',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify(entry),
  });
}
