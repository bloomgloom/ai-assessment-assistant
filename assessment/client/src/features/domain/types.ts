export interface SubjectItem {
  year: number;
  semester: number;
  grade: number;
  subject: string;
  class_id: number;
  fixedDomains: { name: string; max_score: number; sort_order: number }[];
  customDomains: { id: number; name: string }[];
  has_source?: number;
}

export interface AssignmentResource {
  id: number;
  filename: string;
  filepath: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  source_url: string;
  checked_at: string;
}

export interface AssignmentClassSnapshot {
  id: number;
  assessment_class_id: number;
  room: string;
  student_count: number;
}

export interface AssignmentConfig {
  id: number;
  year: number;
  semester: number;
  grade: number;
  subject: string;
  domain_name: string;
  title: string;
  guide_md: string;
  guide_url: string;
  guide_checked_at: string;
  resolved_guide_md?: string;
  guide_fetch_error?: string;
  allowed_extensions: string;
  max_file_size_mb: number;
  max_files: number;
  is_open: number;
  share_code: string;
  viewer_code: string;
  updated_at: string;
}

export interface AssignmentRunSummary {
  id: number;
  is_open: number;
  started_at: string;
  ended_at: string;
  room: string;
  target_count: number;
  absent_count: number;
  submitted_student_count: number;
  accepted_file_count: number;
  submission_event_count: number;
  checked_student_count: number;
}

export interface AssignmentRunStudent {
  id: number;
  assignment_student_id: number | null;
  assessment_student_id: number;
  student_num: number;
  class_num: number;
  seat_num: number;
  name: string;
  is_absent: number;
  absent_at: string;
  sort_order: number;
}

export interface AssignmentRunSubmission {
  id: number;
  assignment_student_id: number | null;
  student_num: number;
  class_num: number;
  seat_num: number;
  name: string;
  ip_address: string;
  original_filename: string;
  size: number;
  status: 'accepted' | 'no_file' | 'rejected' | string;
  reject_reason: string;
  teacher_checked: number;
  teacher_checked_at: string;
  submitted_at: string;
}

export interface AssignmentRunDetail {
  run: AssignmentRunSummary & {
    title: string;
    year: number;
    semester: number;
    grade: number;
    subject: string;
    domain_name: string;
  };
  students: AssignmentRunStudent[];
  submissions: AssignmentRunSubmission[];
}

export interface SubjectDomainRow {
  id?: number | string;
  year?: number;
  semester?: number;
  grade?: number;
  subject?: string;
  credit?: number;
  eval_type: '지필' | '수행' | '기록' | string;
  name: string;
  reflected: 'O' | 'X' | string;
  ratio: number | string;
  max_score: number | string;
  sort_order?: number;
  source_filename?: string;
}

export interface CommentsItem {
  id?: number;
  type: string;
  title: string;
  prompt: string;
  extensions: string;
  sort_order: number;
}

export interface EvalItem {
  id?: number;
  name: string;
  score: string;
  item_type: 'llm' | 'formula';
  rubric: string;
  sort_order: number;
}

export interface StandardRef {
  domain_name_ref: string;
  code: string;
  content: string;
}

export interface AiPromptRow {
  prompt_key: string;
  prompt: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
