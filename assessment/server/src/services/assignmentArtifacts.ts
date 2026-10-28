import { queryOne } from './db';
import { assignmentQueryAll } from './assignmentDb';

export interface AssignmentArtifact {
  id: number;
  filename: string;
  filepath: string;
  mime_type: string;
  domain: string;
  uploaded_at: string;
  source: 'artifact' | 'assignment';
}

export async function assignmentArtifactsForStudent(
  assessmentStudentId: number | string,
  domain: string
): Promise<AssignmentArtifact[]> {
  const student = await queryOne<{
    class_id: number;
    student_num: number;
    name: string;
  }>(
    'SELECT class_id, student_num, name FROM class_students WHERE id=?',
    [assessmentStudentId]
  );
  if (!student) return [];

  return assignmentQueryAll<AssignmentArtifact>(
    `WITH ranked_assignment AS (
       SELECT sub.id, sub.original_filename AS filename, sub.filepath, sub.mime_type,
              cfg.domain_name AS domain, sub.submitted_at AS uploaded_at,
              DENSE_RANK() OVER (
                PARTITION BY cfg.id, sub.submission_slot_id
                ORDER BY sub.submitted_at DESC, sub.submission_batch_id DESC
              ) AS latest_rank
       FROM assignment_submissions sub
       JOIN assignment_runs run ON run.id=sub.run_id
       JOIN assignment_configs cfg ON cfg.id=run.config_id
       JOIN assignment_classes ac ON ac.id=run.assignment_class_id
       LEFT JOIN assignment_students ast ON ast.id=sub.assignment_student_id
       WHERE cfg.domain_name=? AND sub.status='accepted' AND sub.submission_slot_id!=''
         AND (
           ast.assessment_student_id=?
           OR (ac.assessment_class_id=? AND sub.student_num=? AND sub.name=?)
         )
     )
     SELECT id, filename, filepath, mime_type, domain, uploaded_at, 'artifact' AS source
     FROM assignment_artifacts
     WHERE assessment_student_id=? AND domain=?
     UNION ALL
     SELECT id, filename, filepath, mime_type, domain, uploaded_at, 'assignment' AS source
     FROM ranked_assignment
     WHERE latest_rank=1
     ORDER BY uploaded_at DESC, id DESC`,
    [
      domain,
      assessmentStudentId,
      student.class_id,
      student.student_num,
      student.name,
      assessmentStudentId,
      domain,
    ]
  );
}
