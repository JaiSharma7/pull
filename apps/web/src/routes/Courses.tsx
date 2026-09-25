import { useEffect, useState } from 'react';
import { isOfflineFailure } from '../lib/offline.js';
import {
  courseProgressLabel,
  courseStatus,
  courseTitle,
  type CourseSummary,
} from '../lib/study-course.js';
import { fetchCourses } from '../lib/study-course-api.js';

function statusLine(course: CourseSummary): string {
  switch (courseStatus(course)) {
    case 'preparing':
      return 'Being prepared';
    case 'failed':
      return 'Could not be prepared';
    case 'empty':
      return 'A source was deleted';
    case 'ready':
      return courseProgressLabel(course);
  }
}

/** The reader's private courses: each one's name, where it stands, and a way in. */
export function Courses({
  userId,
  onNavigate,
}: {
  userId: string;
  onNavigate: (to: string) => void;
}) {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchCourses(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setCourses(items);
        setError(null);
        setSettled(true);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Courses request failed', e);
        setOffline(isOfflineFailure(e));
        setError(e instanceof Error ? e.message : String(e));
        setSettled(true);
      });
    return () => controller.abort();
  }, [userId, attempt]);

  if (!settled) {
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );
  }

  if (error) {
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Courses</p>
        <h1>Could not load your courses.</h1>
        <p>{offline ? 'You appear to be offline. Courses need an active connection.' : error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setSettled(false);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="stack measure">
      <p className="meta">Courses</p>
      <h1>Study your own material.</h1>
      <p>
        A course is made from sources you saved in Studio: short lessons, each tied to the passages
        of your text it rests on, in sessions of about ten minutes with a clear place to stop.
      </p>
      {courses.length === 0 ? (
        <>
          <p className="meta">You have no courses yet.</p>
          <p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onNavigate('/studio?view=study')}
            >
              Prepare study material in Studio
            </button>
          </p>
        </>
      ) : (
        <>
          <ol className="courses__list">
            {courses.map((c) => (
              <li key={c.courseId} className="courses__item">
                <button
                  type="button"
                  className="btn btn--plain courses__title"
                  onClick={() => onNavigate(`/course/${encodeURIComponent(c.courseId)}`)}
                >
                  {courseTitle(c)}
                </button>
                <span className="courses__status">{statusLine(c)}</span>
                {c.title && <p className="meta">Goal: {c.goal}</p>}
              </li>
            ))}
          </ol>
          <p className="meta">
            That is every course. They are private to you, and new ones are made in Studio.
          </p>
        </>
      )}
    </section>
  );
}
