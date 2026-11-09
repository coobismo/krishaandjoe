const asDate = (value) => value?.toDate ? value.toDate() : value;

function fromFirestore(data) {
  if (!data) return null;
  return {
    ...data,
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
    expiresAt: asDate(data.expiresAt),
    lease: data.lease ? { ...data.lease, until: asDate(data.lease.until) } : null,
  };
}

// mutate must be synchronous and side-effect free: Firestore may retry it.
// Native Date fields are stored as Firestore Timestamps; expiresAt can be a TTL
// field, after the same 24-hour period enforced by the service itself.
export function createFirestoreRepository(firestore) {
  const collection = firestore.collection('weddingPhotoUploads');
  return {
    async transaction(uploadId, mutate) {
      const ref = collection.doc(uploadId);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const outcome = mutate(snapshot.exists ? fromFirestore(snapshot.data()) : null);
        if (outcome.record !== undefined) transaction.set(ref, outcome.record);
        return outcome.value;
      });
    },
  };
}
