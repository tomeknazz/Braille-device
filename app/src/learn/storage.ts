// Persists course progress in localStorage. Storage may be missing or throw
// (private window, blocked site data) — the course then simply runs from an
// empty state for this session. Profiles and IndexedDB come with week 7.

import type { Curriculum } from './curriculum';
import { CourseProgress, emptyProgress, sanitize } from './progress';

export const PROGRESS_KEY = 'braillelab.progress.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadProgress(curriculum: Curriculum): CourseProgress {
  try {
    const raw = storage()?.getItem(PROGRESS_KEY);
    return new CourseProgress(curriculum, raw ? sanitize(JSON.parse(raw), curriculum) : emptyProgress());
  } catch {
    return new CourseProgress(curriculum);
  }
}

/** Returns false when the progress could not be saved. */
export function saveProgress(progress: CourseProgress): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(PROGRESS_KEY, JSON.stringify(progress.toJSON()));
    return true;
  } catch {
    return false;
  }
}
