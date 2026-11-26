import { useState, useEffect, useCallback, useMemo } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import CreateExamModal from '@/components/CreateExamModal';
import SessionReviewModal from '@/components/SessionReviewModal';
import LiveMonitorModal from '@/components/LiveMonitorModal';
import { supabase, AppError } from '@/lib/supabase';
import { authService } from '@/services/authService';
import {
  examService,
  type TeacherDashboardPayload,
  type TeacherExamRow,
  type TeacherSessionSummary,
} from '@/services/examService';
import {
  downloadCsv,
  downloadExcelWorkbook,
  downloadPdfReport,
  type TabularSheet,
} from '@/utils/reportExport';
import type { User } from '@/types';
import { pickAvatarColor } from '@/utils/permissions';
import {
  Users,
  FileText,
  Clock,
  TrendingUp,
  LogOut,
  Search,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Eye,
  Plus,
  Loader2,
  Copy,
  Check,
  RefreshCw,
  Download,
  Edit3,
  Play,
  Square,
  Send,
  Camera,
  Mic,
  ScreenShare,
  Radio,
  Bell,
  ChevronLeft,
  ChevronRight,
  UserCheck,
} from 'lucide-react';

interface TeacherDashboardProps {
  user: User;
  onLogout: () => void;
}

type StatusFilter =
  | 'all'
  | 'completed'
  | 'in-progress'
  | 'flagged'
  | 'disconnected'
  | 'not-started'
  | 'absent';

type SortKey = 'recent' | 'score' | 'flags' | 'name';

interface UnifiedStudentRow {
  key: string;
  sessionId: string | null;
  sessionObj: TeacherSessionSummary | null;
  name: string;
  email: string;
  examTitle: string;
  score: number;
  totalMarks: number;
  percentage: number;
  uiStatus: Exclude<StatusFilter, 'all'>;
  flags: number;
  pendingEvents: number;
  reviewPriority: 'low' | 'moderate' | 'high';
  submittedAt: string;
  sortTime: number;
  camOk: boolean;
  micOk: boolean;
  screenOk: boolean;
  completionPct: number;
}

const PAGE_SIZE = 15;

export default function TeacherDashboard({ user, onLogout }: TeacherDashboardProps) {
  const [selectedExamId, setSelectedExamId] = useState<string>('');
  const [dashboard, setDashboard] = useState<TeacherDashboardPayload | null>(null);
  const [liveHallSessions, setLiveHallSessions] = useState<TeacherSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('recent');
  const [page, setPage] = useState(1);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [reviewSessionId, setReviewSessionId] = useState<string | null>(null);
  const [monitorSession, setMonitorSession] = useState<TeacherSessionSummary | null>(null);

  const [copiedCode, setCopiedCode] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [liveAlertText, setLiveAlertText] = useState<string | null>(null);
  const [highlightedSessionIds, setHighlightedSessionIds] = useState<Set<string>>(new Set());

  // Admin-only pending teacher approval requests
  const [teacherRequests, setTeacherRequests] = useState<
    Array<{ id: string; email: string; full_name: string; institution: string; created_at: string }>
  >([]);

  const fetchDashboard = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError('');
      try {
        const [data, activeHall] = await Promise.all([
          examService.getTeacherDashboard(selectedExamId || null),
          examService.getLiveHallSessions().catch(() => [] as TeacherSessionSummary[]),
        ]);
        setDashboard(data);
        setLiveHallSessions(activeHall);
        if (!selectedExamId && data.exams.length === 1 && activeHall.length === 0) {
          setSelectedExamId(data.exams[0].id);
        }
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        setError(appErr?.message ?? 'Unable to load dashboard data from server.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedExamId]
  );

  useEffect(() => {
    void fetchDashboard(false);
    // Continuous 4-second background sync alongside Realtime WebSockets so any student
    // starting an exam immediately registers on the Teacher Portal without manual refresh.
    const pollId = window.setInterval(() => {
      void fetchDashboard(true);
    }, 4000);
    return () => window.clearInterval(pollId);
  }, [fetchDashboard]);

  // Load pending faculty requests if administrator
  useEffect(() => {
    if (user.accountRole !== 'admin') return;
    authService
      .listTeacherRequests('pending')
      .then((list) => setTeacherRequests(list))
      .catch(() => {});
  }, [user.accountRole]);

  // Real-time subscriptions for live proctoring events and student session updates
  useEffect(() => {
    const channel = supabase
      .channel(`teacher-dashboard:${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exam_sessions' },
        () => {
          void fetchDashboard(true);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'proctoring_events' },
        (payload) => {
          const ev = payload.new as {
            session_id?: string;
            event_type?: string;
            category?: string;
            description?: string;
          };
          if (ev.category === 'suspicious' && ev.session_id) {
            setLiveAlertText(
              `Live Alert: ${(ev.event_type ?? 'event').replace(/_/g, ' ')} — ${ev.description ?? ''}`
            );
            setHighlightedSessionIds((prev) => new Set(prev).add(ev.session_id!));
          }
          void fetchDashboard(true);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchDashboard, user.id]);

  const selectedExam: TeacherExamRow | null = useMemo(() => {
    if (!dashboard) return null;
    if (selectedExamId) {
      return dashboard.exams.find((e) => e.id === selectedExamId) ?? null;
    }
    return dashboard.exams[0] ?? null;
  }, [dashboard, selectedExamId]);

  const rows: UnifiedStudentRow[] = useMemo(() => {
    if (!dashboard && liveHallSessions.length === 0) return [];

    // Merge owned exam sessions with any active portal-wide in_progress student sessions
    const mergedSessionsMap = new Map<string, TeacherSessionSummary>();
    for (const s of dashboard?.sessions ?? []) {
      mergedSessionsMap.set(s.id, s);
    }
    for (const liveS of liveHallSessions) {
      if (!selectedExamId || liveS.exam_id === selectedExamId) {
        mergedSessionsMap.set(liveS.id, liveS);
      }
    }

    const sessionRows: UnifiedStudentRow[] = Array.from(mergedSessionsMap.values()).map((s) => {
      let uiStatus: UnifiedStudentRow['uiStatus'] = 'completed';
      if (s.status === 'flagged' || s.review_priority === 'high') {
        uiStatus = 'flagged';
      } else if (s.live_state === 'disconnected') {
        uiStatus = 'disconnected';
      } else if (s.status === 'in_progress') {
        uiStatus = 'in-progress';
      } else if (s.status === 'not_started') {
        uiStatus = 'not-started';
      }

      const sortTime = Date.parse(s.submitted_at ?? s.started_at ?? '') || 0;
      const completionPct =
        s.status === 'submitted' || s.status === 'flagged'
          ? 100
          : s.total_questions > 0
            ? Math.round((s.answered_count / s.total_questions) * 100)
            : 0;

      return {
        key: `sess-${s.id}`,
        sessionId: s.id,
        sessionObj: s,
        name: s.student_name,
        email: s.student_email,
        examTitle: s.exam_title,
        score: Number(s.score ?? 0),
        totalMarks: s.total_marks,
        percentage: Number(s.percentage ?? 0),
        uiStatus,
        flags: s.proctoring_flags,
        pendingEvents: s.pending_events,
        reviewPriority: s.review_priority,
        submittedAt: s.submitted_at
          ? new Date(s.submitted_at).toLocaleString('en-US', {
              dateStyle: 'short',
              timeStyle: 'short',
            })
          : '',
        sortTime,
        camOk: s.camera_status === 'ok',
        micOk: s.mic_status === 'ok',
        screenOk: s.screen_status === 'ok',
        completionPct,
      };
    });

    const unstartedRows: UnifiedStudentRow[] = (dashboard?.unstarted_roster ?? []).map((u, idx) => ({
      key: `roster-${u.exam_id}-${u.student_email}-${idx}`,
      sessionId: null,
      sessionObj: null,
      name: u.student_name,
      email: u.student_email,
      examTitle: u.exam_title,
      score: 0,
      totalMarks: 0,
      percentage: 0,
      uiStatus: u.state === 'absent' ? 'absent' : 'not-started',
      flags: 0,
      pendingEvents: 0,
      reviewPriority: 'low',
      submittedAt: '',
      sortTime: 0,
      camOk: false,
      micOk: false,
      screenOk: false,
      completionPct: 0,
    }));

    return [...sessionRows, ...unstartedRows];
  }, [dashboard, liveHallSessions, selectedExamId]);

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      const matchesSearch =
        !q ||
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.examTitle.toLowerCase().includes(q);
      const matchesFilter =
        filter === 'all' ||
        r.uiStatus === filter ||
        (filter === 'flagged' && r.flags > 0);
      return matchesSearch && matchesFilter;
    });

    list.sort((a, b) => {
      if (sortBy === 'score') return b.percentage - a.percentage;
      if (sortBy === 'flags') return b.flags - a.flags;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      return b.sortTime - a.sortTime;
    });
    return list;
  }, [rows, search, filter, sortBy]);

  useEffect(() => {
    setPage(1);
  }, [search, filter, sortBy, selectedExamId]);

  const totalPages = Math.max(1, Math.ceil(filteredAndSorted.length / PAGE_SIZE));
  const pagedRows = filteredAndSorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Real-time counts
  const totalRegistered = rows.length;
  const completedCount = rows.filter(
    (r) => r.uiStatus === 'completed' || (r.uiStatus === 'flagged' && r.submittedAt !== '')
  ).length;
  const attendingCount = rows.filter((r) => r.uiStatus === 'in-progress').length;
  const disconnectedCount = rows.filter((r) => r.uiStatus === 'disconnected').length;
  const notStartedCount = rows.filter((r) => r.uiStatus === 'not-started').length;
  const absentCount = rows.filter((r) => r.uiStatus === 'absent').length;
  const flaggedCount = rows.filter((r) => r.uiStatus === 'flagged' || r.flags > 0).length;
  const activeSessions = rows.filter((r) => r.uiStatus === 'in-progress' || r.uiStatus === 'disconnected');
  const camConnectedCount = activeSessions.filter((r) => r.camOk).length;
  const micConnectedCount = activeSessions.filter((r) => r.micOk).length;
  const screenConnectedCount = activeSessions.filter((r) => r.screenOk).length;
  const overallCompletionPct =
    totalRegistered > 0 ? Math.round((completedCount / totalRegistered) * 100) : 0;

  const stats = [
    { icon: Users, label: 'Total Students', value: totalRegistered, color: 'brand' },
    { icon: CheckCircle2, label: 'Completed', value: completedCount, color: 'success' },
    { icon: Clock, label: 'Attending Live', value: attendingCount, color: 'warning' },
    { icon: AlertTriangle, label: 'Flagged', value: flaggedCount, color: 'error' },
  ];

  const colorMap: Record<string, string> = {
    brand: 'bg-brand-50 text-brand-600',
    success: 'bg-success-50 text-success-600',
    warning: 'bg-warning-50 text-warning-600',
    error: 'bg-error-50 text-error-600',
  };

  async function handleCopyJoinCode(code: string) {
    await navigator.clipboard.writeText(code).catch(() => {});
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 2000);
  }

  async function handleRegenerateCode(examId: string) {
    setBusyAction('regen');
    try {
      await examService.regenerateJoinCode(examId);
      await fetchDashboard(true);
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not regenerate code.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleToggleExamStatus(exam: TeacherExamRow) {
    const nextStatus = exam.status === 'published' ? 'ended' : 'published';
    setBusyAction('status');
    try {
      await examService.setExamStatus(exam.id, nextStatus);
      await fetchDashboard(true);
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not update exam status.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTogglePublishResults(exam: TeacherExamRow) {
    setBusyAction('results');
    try {
      await examService.publishResults(exam.id, !exam.results_published);
      await fetchDashboard(true);
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not update result publication.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExport(exam: TeacherExamRow, format: 'csv' | 'xls' | 'pdf') {
    setBusyAction(`export-${format}`);
    try {
      const rep = await examService.exportExamReport(exam.id);
      const resultsSheet: TabularSheet = {
        name: 'Results',
        headers: [
          'Student Name',
          'Email',
          'Attempt',
          'Status',
          'Objective Marks',
          'Manual Marks',
          'Total Score',
          'Max Marks',
          'Percentage',
          'Passed',
          'Flags',
          'Review Priority',
          'Submitted At',
        ],
        rows: rep.results.map((r) => [
          String(r.student_name ?? ''),
          String(r.student_email ?? ''),
          Number(r.attempt_no ?? 1),
          String(r.status ?? ''),
          Number(r.objective_score ?? 0),
          Number(r.manual_score ?? 0),
          Number(r.score ?? 0),
          Number(r.total_marks ?? 0),
          Number(r.percentage ?? 0),
          r.passed === null ? 'Pending' : r.passed ? 'PASS' : 'FAIL',
          Number(r.proctoring_flags ?? 0),
          String(r.review_priority ?? 'low'),
          String(r.submitted_at ?? ''),
        ]),
      };

      const proctorSheet: TabularSheet = {
        name: 'Proctoring Activity',
        headers: [
          'Timestamp',
          'Student',
          'Email',
          'Event Type',
          'Category',
          'Severity',
          'Confidence',
          'Occurrences',
          'Weight',
          'Review Status',
          'Remarks',
        ],
        rows: rep.proctoring_events.map((ev) => [
          String(ev.created_at ?? ''),
          String(ev.student_name ?? ''),
          String(ev.student_email ?? ''),
          String(ev.event_type ?? ''),
          String(ev.category ?? ''),
          String(ev.severity ?? ''),
          ev.confidence !== null && ev.confidence !== undefined ? Number(ev.confidence) : '',
          Number(ev.occurrences ?? 1),
          Number(ev.weight ?? 0),
          String(ev.review_status ?? ''),
          String(ev.teacher_remarks ?? ''),
        ]),
      };

      const qAnalyticsSheet: TabularSheet = {
        name: 'Question Analytics',
        headers: ['Q#', 'Section', 'Type', 'Marks', 'Attempts', 'Correct', 'Accuracy %', 'Avg Marks'],
        rows: (dashboard?.question_analytics ?? [])
          .filter((qa) => qa.exam_id === exam.id)
          .map((qa) => [
            qa.display_order,
            qa.section,
            qa.question_type,
            qa.marks,
            qa.attempts,
            qa.correct_count,
            qa.accuracy_pct,
            qa.avg_marks,
          ]),
      };

      const baseSlug = `${exam.course_code}-${exam.title}`.slice(0, 48);
      if (format === 'csv') {
        downloadCsv(resultsSheet, `${baseSlug}-results.csv`);
        if (proctorSheet.rows.length > 0) {
          downloadCsv(proctorSheet, `${baseSlug}-proctoring.csv`);
        }
      } else if (format === 'xls') {
        downloadExcelWorkbook([resultsSheet, qAnalyticsSheet, proctorSheet], `${baseSlug}-report.xls`);
      } else {
        downloadPdfReport(
          `${exam.course_code} — ${exam.title}`,
          `Generated ${new Date(rep.generated_at).toLocaleString()} · Pass mark ${exam.pass_percentage}%`,
          [resultsSheet, qAnalyticsSheet, proctorSheet],
          `${baseSlug}-report.pdf`
        );
      }
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Export failed.');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTeacherRequestDecision(reqId: string, approve: boolean) {
    setBusyAction(reqId);
    try {
      await authService.reviewTeacherRequest(reqId, approve);
      setTeacherRequests((prev) => prev.filter((r) => r.id !== reqId));
    } finally {
      setBusyAction(null);
    }
  }

  const gradedRows = rows.filter((r) => r.uiStatus === 'completed' || r.uiStatus === 'flagged');

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Logo size="sm" />
          <div className="flex items-center gap-3">
            <div className="hidden sm:block text-right">
              <p className="text-sm font-semibold text-neutral-800 leading-none">{user.name}</p>
              <p className="text-xs text-neutral-500 mt-0.5">
                {user.accountRole === 'admin' ? 'Administrator' : 'Faculty'} · {user.email}
              </p>
            </div>
            <div
              className="flex items-center justify-center h-9 w-9 rounded-full text-white text-sm font-bold"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Live real-time alert notification */}
        {liveAlertText && (
          <div className="mb-6 p-3.5 rounded-xl bg-error-600 text-white flex items-center justify-between gap-3 text-sm font-semibold animate-fade-in">
            <span className="flex items-center gap-2">
              <Bell className="h-4 w-4 flex-shrink-0" />
              {liveAlertText}
            </span>
            <button
              onClick={() => setLiveAlertText(null)}
              className="px-2.5 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-xs font-bold"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void fetchDashboard(false)}>
              Retry
            </Button>
          </div>
        )}

        {/* Title */}
        <div className="mb-6 flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900">Exam Management Dashboard</h1>
            <p className="text-neutral-500 mt-1">
              {selectedExam
                ? `${selectedExam.course_code} — ${selectedExam.title}`
                : 'Create or select an examination to monitor live sessions and publish results'}
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <Button variant="ghost" size="sm" onClick={() => void fetchDashboard(false)} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              onClick={() => {
                setEditingExamId(null);
                setShowCreateModal(true);
              }}
            >
              <Plus className="h-4 w-4" />
              Create New Exam
            </Button>
          </div>
        </div>

        {/* Admin Faculty Approval Queue */}
        {user.accountRole === 'admin' && teacherRequests.length > 0 && (
          <div className="bg-white rounded-2xl card-shadow p-5 mb-6 border border-brand-200">
            <div className="flex items-center gap-2 mb-3">
              <UserCheck className="h-5 w-5 text-brand-600" />
              <h3 className="text-sm font-bold text-neutral-900 uppercase tracking-wide">
                Pending Faculty Provisioning Requests ({teacherRequests.length})
              </h3>
            </div>
            <div className="divide-y divide-neutral-100">
              {teacherRequests.map((req) => (
                <div key={req.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold text-neutral-900">{req.full_name}</p>
                    <p className="text-xs text-neutral-500">
                      {req.email} {req.institution ? `· ${req.institution}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyAction === req.id}
                      onClick={() => void handleTeacherRequestDecision(req.id, false)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="success"
                      disabled={busyAction === req.id}
                      onClick={() => void handleTeacherRequestDecision(req.id, true)}
                    >
                      Approve Faculty
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Examination Control Bar */}
        {dashboard && dashboard.exams.length > 0 && (
          <div className="bg-white rounded-2xl card-shadow p-4 mb-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={selectedExamId}
                onChange={(e) => setSelectedExamId(e.target.value)}
                className="px-3.5 py-2 rounded-xl border border-neutral-300 text-sm font-semibold text-neutral-800 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">All My Examinations ({dashboard.exams.length})</option>
                {dashboard.exams.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.course_code} — {ex.title} ({ex.status})
                  </option>
                ))}
              </select>

              {selectedExam?.join_code && (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-brand-50 border border-brand-200">
                  <span className="text-xs font-medium text-brand-700">Join Code:</span>
                  <span className="font-mono text-sm font-bold tracking-wider text-brand-900">
                    {selectedExam.join_code}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyJoinCode(selectedExam.join_code!)}
                    className="text-brand-600 hover:text-brand-800"
                    title="Copy joining code"
                  >
                    {copiedCode ? <Check className="h-3.5 w-3.5 text-success-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegenerateCode(selectedExam.id)}
                    disabled={busyAction === 'regen'}
                    className="text-brand-600 hover:text-brand-800"
                    title="Regenerate joining code"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${busyAction === 'regen' ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              )}
            </div>

            {selectedExam && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingExamId(selectedExam.id);
                    setShowCreateModal(true);
                  }}
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  Edit
                </Button>

                {selectedExam.status === 'published' ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyAction === 'status'}
                    onClick={() => void handleToggleExamStatus(selectedExam)}
                  >
                    <Square className="h-3.5 w-3.5" />
                    End Exam
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="success"
                    disabled={busyAction === 'status'}
                    onClick={() => void handleToggleExamStatus(selectedExam)}
                  >
                    <Play className="h-3.5 w-3.5" />
                    Publish Exam
                  </Button>
                )}

                <Button
                  size="sm"
                  variant={selectedExam.results_published ? 'secondary' : 'primary'}
                  disabled={busyAction === 'results'}
                  onClick={() => void handleTogglePublishResults(selectedExam)}
                >
                  <Send className="h-3.5 w-3.5" />
                  {selectedExam.results_published ? 'Unpublish Results' : 'Publish Results'}
                </Button>

                <div className="flex items-center gap-1 border-l border-neutral-200 pl-2">
                  {(['csv', 'xls', 'pdf'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => void handleExport(selectedExam, fmt)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-xs font-bold uppercase text-neutral-700 transition-colors"
                      title={`Export ${fmt.toUpperCase()} report`}
                    >
                      <Download className="h-3 w-3" />
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Live Examination Hall — Active Students Currently Giving Exam */}
        {liveHallSessions.length > 0 && (
          <div className="bg-white rounded-2xl card-shadow p-5 mb-6 border border-success-200 animate-fade-in">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-success-600" />
                </span>
                <h2 className="text-base font-bold text-neutral-900">
                  Live Examination Hall — {liveHallSessions.length} Student{liveHallSessions.length === 1 ? '' : 's'} Giving Exam Now
                </h2>
              </div>
              <span className="text-xs font-medium text-neutral-500">
                Click &ldquo;Peek Live&rdquo; on any student to view live camera, listen/record microphone &amp; monitor screen
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {liveHallSessions.map((s) => (
                <div
                  key={s.id}
                  className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 flex flex-col justify-between gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        className="flex items-center justify-center h-9 w-9 rounded-full text-white text-sm font-bold flex-shrink-0"
                        style={{ backgroundColor: pickAvatarColor(s.student_email) }}
                      >
                        {s.student_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-neutral-900 truncate">{s.student_name}</p>
                        <p className="text-xs text-neutral-500 truncate">{s.student_email}</p>
                      </div>
                    </div>
                    {s.proctoring_flags > 0 ? (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-error-50 text-error-700 flex-shrink-0">
                        {s.proctoring_flags} flag{s.proctoring_flags > 1 ? 's' : ''}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-success-50 text-success-700 flex-shrink-0">
                        Live
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-neutral-600">
                    <span className="font-medium truncate">
                      {s.course_code} · {s.answered_count}/{s.total_questions} answered
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Camera className={`h-3.5 w-3.5 ${s.camera_status === 'ok' ? 'text-success-600' : 'text-neutral-400'}`} />
                      <Mic className={`h-3.5 w-3.5 ${s.mic_status === 'ok' ? 'text-success-600' : 'text-neutral-400'}`} />
                      <ScreenShare className={`h-3.5 w-3.5 ${s.screen_status === 'ok' ? 'text-success-600' : 'text-neutral-400'}`} />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      fullWidth
                      onClick={() => setMonitorSession(s)}
                    >
                      <Radio className="h-4 w-4" />
                      Peek Live (Cam &amp; Mic)
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReviewSessionId(s.id)}
                      title="View activity timeline"
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-white rounded-2xl card-shadow p-5">
              <div className={`flex items-center justify-center h-10 w-10 rounded-xl mb-3 ${colorMap[stat.color]}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              {loading ? (
                <Loader2 className="h-7 w-7 text-neutral-300 animate-spin" />
              ) : (
                <p className="text-3xl font-bold text-neutral-900">{stat.value}</p>
              )}
              <p className="text-sm text-neutral-500 mt-1">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Live Telemetry Strip */}
        <div className="bg-white rounded-2xl card-shadow px-5 py-3 mb-8 flex items-center justify-between flex-wrap gap-3 text-xs font-semibold text-neutral-600">
          <div className="flex items-center gap-4 flex-wrap">
            <span>Not Started: <strong className="text-neutral-900">{notStartedCount}</strong></span>
            <span>Disconnected: <strong className="text-warning-600">{disconnectedCount}</strong></span>
            <span>Absent: <strong className="text-neutral-900">{absentCount}</strong></span>
            <span>Pending Alerts: <strong className="text-error-600">{dashboard?.pending_alerts ?? 0}</strong></span>
            <span>Completion: <strong className="text-success-600">{overallCompletionPct}%</strong></span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <Camera className="h-3.5 w-3.5 text-brand-600" />
              Cam {camConnectedCount}/{activeSessions.length}
            </span>
            <span className="inline-flex items-center gap-1">
              <Mic className="h-3.5 w-3.5 text-brand-600" />
              Mic {micConnectedCount}/{activeSessions.length}
            </span>
            <span className="inline-flex items-center gap-1">
              <ScreenShare className="h-3.5 w-3.5 text-brand-600" />
              Screen {screenConnectedCount}/{activeSessions.length}
            </span>
            {selectedExam && (dashboard?.pending_alerts ?? 0) > 0 && (
              <button
                type="button"
                onClick={() =>
                  void examService.acknowledgeAllAlerts(selectedExam.id).then(() => fetchDashboard(true))
                }
                className="text-brand-600 hover:text-brand-800 underline"
              >
                Acknowledge All Alerts
              </button>
            )}
          </div>
        </div>

        {/* Filter + Search + Sort */}
        <div className="bg-white rounded-2xl card-shadow overflow-hidden">
          <div className="p-4 border-b border-neutral-200 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {(
                [
                  ['all', 'All'],
                  ['completed', 'Completed'],
                  ['in-progress', 'Attending'],
                  ['disconnected', 'Disconnected'],
                  ['not-started', 'Not Started'],
                  ['absent', 'Absent'],
                  ['flagged', 'Flagged'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                    filter === key
                      ? 'bg-brand-600 text-white'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                aria-label="Sort students"
                className="px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-700 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="recent">Sort: Recent</option>
                <option value="score">Sort: Score</option>
                <option value="flags">Sort: Flags</option>
                <option value="name">Sort: Name</option>
              </select>
              <div className="relative flex-1 sm:flex-initial">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search students…"
                  className="pl-9 pr-4 py-2 rounded-lg border border-neutral-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent w-full sm:w-60"
                />
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-neutral-50 border-b border-neutral-200">
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3">Student</th>
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3 hidden md:table-cell">Exam</th>
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3">Score</th>
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3">Status</th>
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Proctoring & Media</th>
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Submitted</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {!loading &&
                  pagedRows.map((r) => {
                    const isHighlighted = r.sessionId ? highlightedSessionIds.has(r.sessionId) : false;
                    return (
                      <tr
                        key={r.key}
                        className={`transition-colors ${
                          isHighlighted ? 'bg-error-50/70 hover:bg-error-50' : 'hover:bg-neutral-50'
                        }`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div
                              className="flex items-center justify-center h-9 w-9 rounded-full text-white text-sm font-bold flex-shrink-0"
                              style={{ backgroundColor: pickAvatarColor(r.email) }}
                            >
                              {r.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-neutral-900 truncate">{r.name}</p>
                              <p className="text-xs text-neutral-500 truncate">{r.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-sm text-neutral-600">{r.examTitle}</span>
                        </td>
                        <td className="px-4 py-3">
                          {r.uiStatus === 'in-progress' ||
                          r.uiStatus === 'disconnected' ||
                          r.uiStatus === 'not-started' ||
                          r.uiStatus === 'absent' ? (
                            <span className="text-xs font-semibold text-neutral-400">
                              {r.uiStatus === 'in-progress' || r.uiStatus === 'disconnected'
                                ? `${r.completionPct}% answered`
                                : '—'}
                            </span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-neutral-900">{r.percentage}%</span>
                              <span className="text-xs text-neutral-400">({r.score}/{r.totalMarks})</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {r.uiStatus === 'completed' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-success-50 text-success-700">
                              <CheckCircle2 className="h-3 w-3" />
                              Completed
                            </span>
                          )}
                          {r.uiStatus === 'in-progress' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-warning-50 text-warning-700">
                              <Clock className="h-3 w-3" />
                              Attending
                            </span>
                          )}
                          {r.uiStatus === 'disconnected' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-error-50 text-error-700">
                              <AlertTriangle className="h-3 w-3" />
                              Disconnected
                            </span>
                          )}
                          {r.uiStatus === 'not-started' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-neutral-100 text-neutral-600">
                              Not Started
                            </span>
                          )}
                          {r.uiStatus === 'absent' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-neutral-200 text-neutral-700">
                              Absent
                            </span>
                          )}
                          {r.uiStatus === 'flagged' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-error-50 text-error-700">
                              <AlertTriangle className="h-3 w-3" />
                              Flagged
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <div className="flex items-center gap-2.5">
                            {(r.uiStatus === 'in-progress' || r.uiStatus === 'disconnected') && (
                              <div className="flex items-center gap-1">
                                <Camera className={`h-3.5 w-3.5 ${r.camOk ? 'text-success-600' : 'text-error-500'}`} />
                                <Mic className={`h-3.5 w-3.5 ${r.micOk ? 'text-success-600' : 'text-error-500'}`} />
                                <ScreenShare className={`h-3.5 w-3.5 ${r.screenOk ? 'text-success-600' : 'text-neutral-300'}`} />
                              </div>
                            )}
                            {r.flags > 0 ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-error-600">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {r.flags} flag{r.flags > 1 ? 's' : ''}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-600">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                Clean
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <span className="text-sm text-neutral-500">{r.submittedAt || '—'}</span>
                        </td>
                        <td className="px-4 py-3">
                          {r.sessionId && (
                            <div className="flex items-center justify-end gap-1.5">
                              {(r.uiStatus === 'in-progress' || r.uiStatus === 'disconnected') &&
                                r.sessionObj && (
                                  <button
                                    onClick={() => setMonitorSession(r.sessionObj)}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-brand-50 text-brand-700 hover:bg-brand-100 text-xs font-bold transition-colors"
                                    title="Peek live camera, microphone & screen"
                                  >
                                    <Radio className="h-3.5 w-3.5 text-brand-600 animate-pulse" />
                                    Peek Live
                                  </button>
                                )}
                              <button
                                onClick={() => {
                                  setHighlightedSessionIds((prev) => {
                                    const next = new Set(prev);
                                    next.delete(r.sessionId!);
                                    return next;
                                  });
                                  setReviewSessionId(r.sessionId);
                                }}
                                className="p-2 rounded-lg text-neutral-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                                title="Inspect proctoring timeline & grade answers"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {filteredAndSorted.length === 0 && !loading && (
            <div className="p-12 text-center">
              <FileText className="h-12 w-12 text-neutral-300 mx-auto mb-3" />
              <p className="text-sm font-semibold text-neutral-700">
                {dashboard?.exams.length === 0
                  ? 'No examinations created yet'
                  : 'No student sessions match your current filter'}
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                {dashboard?.exams.length === 0
                  ? 'Click "Create New Exam" above to author your first assessment and generate a joining code.'
                  : 'Share your examination joining code with students or adjust your search filter.'}
              </p>
            </div>
          )}

          {loading && (
            <div className="p-12 text-center">
              <Loader2 className="h-8 w-8 text-brand-500 animate-spin mx-auto mb-3" />
              <p className="text-sm text-neutral-500">Loading live examination records…</p>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-neutral-200 flex items-center justify-between text-xs text-neutral-600">
              <span>
                Page {page} of {totalPages} ({filteredAndSorted.length} students)
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Performance overview & Integrity summary */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
          <div className="bg-white rounded-2xl card-shadow p-6">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="h-5 w-5 text-brand-600" />
              <h3 className="text-base font-bold text-neutral-900">Performance Overview</h3>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Excellent (90%+)', count: gradedRows.filter((r) => r.percentage >= 90).length, color: 'bg-success-500' },
                { label: 'Good (70-89%)', count: gradedRows.filter((r) => r.percentage >= 70 && r.percentage < 90).length, color: 'bg-brand-500' },
                { label: 'Average (50-69%)', count: gradedRows.filter((r) => r.percentage >= 50 && r.percentage < 70).length, color: 'bg-warning-400' },
                { label: 'Below 50%', count: gradedRows.filter((r) => r.percentage < 50).length, color: 'bg-error-500' },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-neutral-600">{row.label}</span>
                    <span className="font-bold text-neutral-900">{row.count}</span>
                  </div>
                  <div className="w-full h-2.5 bg-neutral-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${row.color} rounded-full transition-all duration-700`}
                      style={{ width: `${gradedRows.length > 0 ? (row.count / gradedRows.length) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {dashboard && dashboard.section_analytics.length > 0 && (
              <div className="mt-6 pt-4 border-t border-neutral-100 space-y-2">
                <p className="text-xs font-bold text-neutral-500 uppercase tracking-wide">
                  Section / Subject Accuracy
                </p>
                {dashboard.section_analytics.map((sec) => (
                  <div key={sec.section} className="flex items-center justify-between text-xs">
                    <span className="text-neutral-700 font-medium">{sec.section}</span>
                    <span className="font-bold text-neutral-900">
                      {sec.avg_accuracy_pct}% avg accuracy ({sec.questions} Qs)
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl card-shadow p-6">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="h-5 w-5 text-brand-600" />
              <h3 className="text-base font-bold text-neutral-900">Integrity Summary</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-success-50">
                <p className="text-3xl font-bold text-success-700">
                  {rows.filter((r) => r.sessionId && r.flags === 0).length}
                </p>
                <p className="text-sm text-success-600 mt-1">Clean Sessions</p>
              </div>
              <div className="p-4 rounded-xl bg-error-50">
                <p className="text-3xl font-bold text-error-700">
                  {flaggedCount}
                </p>
                <p className="text-sm text-error-600 mt-1">Flagged Sessions</p>
              </div>
              <div className="col-span-2 p-4 rounded-xl bg-neutral-50 border border-neutral-200">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-warning-500 flex-shrink-0" />
                  <p className="text-sm text-neutral-600 leading-relaxed">
                    {flaggedCount} session{flaggedCount !== 1 ? 's' : ''} have reviewable proctoring
                    events. Automated AI detections never auto-fail students — inspect the activity
                    timeline via the eye icon before publishing final grades.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <CreateExamModal
          editExamId={editingExamId}
          onClose={() => {
            setShowCreateModal(false);
            setEditingExamId(null);
          }}
          onCreated={(saved) => {
            setShowCreateModal(false);
            setEditingExamId(null);
            setSelectedExamId(saved.id);
            void fetchDashboard(false);
          }}
        />
      )}

      {reviewSessionId && (
        <SessionReviewModal
          sessionId={reviewSessionId}
          onClose={() => setReviewSessionId(null)}
          onUpdated={() => void fetchDashboard(true)}
        />
      )}

      {monitorSession && (
        <LiveMonitorModal
          session={monitorSession}
          onClose={() => setMonitorSession(null)}
        />
      )}
    </div>
  );
}
