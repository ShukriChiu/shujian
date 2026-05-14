-- Add birth year for intake; nullable for rows submitted before this column existed.

ALTER TABLE future_students
    ADD COLUMN birth_year smallint;

ALTER TABLE future_students
    ADD CONSTRAINT future_students_birth_year_range CHECK (
        birth_year IS NULL
        OR (
            birth_year >= 1940
            AND birth_year <= EXTRACT(YEAR FROM CURRENT_DATE)::smallint
        )
    );
