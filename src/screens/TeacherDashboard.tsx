import { useState, useEffect, useCallback } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import CreateExamModal from '@/components/CreateExamModal';
import { supabase } from '@/lib/supabase';
import type { User } from '@/types';
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
} from 'lucide-react';

interface TeacherDashboardProps {
  user: User;
  onLogout: () => void;
}

interface StudentResult {
  id: string;
  name: string;
  email: string;
  examTitle: string;
  score: number;
  totalMarks: number;
  percentage: number;
  status: 'completed' | 'in-progress' | 'flagged';
  flags: number;
  submittedAt: string;
}

const mockResults: StudentResult[] = [
  { id: '1', name: 'Alice Johnson', email: 'alice@university.edu', examTitle: 'CS 401 Final', score: 92, totalMarks: 100, percentage: 92, status: 'completed', flags: 0, submittedAt: '2026-09-01 14:32' },
  { id: '2', name: 'Bob Smith', email: 'bob@university.edu', examTitle: 'CS 401 Final', score: 78, totalMarks: 100, percentage: 78, status: 'completed', flags: 0, submittedAt: '2026-09-01 14:28' },
  { id: '3', name: 'Charlie Brown', email: 'charlie@university.edu', examTitle: 'CS 401 Final', score: 65, totalMarks: 100, percentage: 65, status: 'completed', flags: 2, submittedAt: '2026-09-01 14:35' },
  { id: '4', name: 'Diana Prince', email: 'diana@university.edu', examTitle: 'CS 401 Final', score: 88, totalMarks: 100, percentage: 88, status: 'completed', flags: 0, submittedAt: '2026-09-01 14:30' },
  { id: '5', name: 'Evan Wright', email: 'evan@university.edu', examTitle: 'CS 401 Final', score: 0, totalMarks: 100, percentage: 0, status: 'in-progress', flags: 0, submittedAt: '' },
  { id: '6', name: 'Fiona Green', email: 'fiona@university.edu', examTitle: 'CS 401 Final', score: 95, totalMarks: 100, percentage: 95, status: 'completed', flags: 0, submittedAt: '2026-09-01 14:25' },
  { id: '7', name: 'George King', email: 'george@university.edu', examTitle: 'CS 401 Final', score: 54, totalMarks: 100, percentage: 54, status: 'flagged', flags: 3, submittedAt: '2026-09-01 14:40' },
  { id: '8', name: 'Hannah Lee', email: 'hannah@university.edu', examTitle: 'CS 401 Final', score: 82, totalMarks: 100, percentage: 82, status: 'completed', flags: 0, submittedAt: '2026-09-01 14:33' },
];

export default function TeacherDashboard({ user, onLogout }: TeacherDashboardProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'completed' | 'in-progress' | 'flagged'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [results, setResults] = useState<StudentResult[]>(mockResults);
  const [loadingResults, setLoadingResults] = useState(true);

  const fetchResults = useCallback(async () => {
    setLoadingResults(true);
    try {
      const { data, error } = await supabase
        .from('exam_sessions')
        .select(`
          id,
          student_name,
          student_email,
          status,
          score,
          total_marks,
          percentage,
          proctoring_flags,
          submitted_at,
          exam:exams(course_code, title)
        `)
        .order('submitted_at', { ascending: false, nullsFirst: false });

      if (error) throw error;

      if (data && data.length > 0) {
        const mapped: StudentResult[] = data.map((row) => {
          const examRow = row.exam as { course_code?: string; title?: string } | null;
          const statusMap: Record<string, 'completed' | 'in-progress' | 'flagged'> = {
            submitted: 'completed',
            in_progress: 'in-progress',
            flagged: 'flagged',
            not_started: 'in-progress',
          };
          return {
            id: row.id,
            name: row.student_name,
            email: row.student_email,
            examTitle: examRow?.title ?? 'Unknown Exam',
            score: Number(row.score),
            totalMarks: row.total_marks,
            percentage: Number(row.percentage),
            status: statusMap[row.status] ?? 'completed',
            flags: row.proctoring_flags,
            submittedAt: row.submitted_at
              ? new Date(row.submitted_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
              : '',
          };
        });
        setResults(mapped);
      }
    } catch {
      // Fall back to mock data if DB is unreachable
    } finally {
      setLoadingResults(false);
    }
  }, []);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const filtered = results.filter((r) => {
    const matchesSearch = r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.email.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === 'all' || r.status === filter;
    return matchesSearch && matchesFilter;
  });

  const stats = [
    { icon: Users, label: 'Total Students', value: results.length, color: 'brand' },
    { icon: CheckCircle2, label: 'Completed', value: results.filter(r => r.status === 'completed').length, color: 'success' },
    { icon: Clock, label: 'In Progress', value: results.filter(r => r.status === 'in-progress').length, color: 'warning' },
    { icon: AlertTriangle, label: 'Flagged', value: results.filter(r => r.status === 'flagged' || r.flags > 0).length, color: 'error' },
  ];

  const colorMap: Record<string, string> = {
    brand: 'bg-brand-50 text-brand-600',
    success: 'bg-success-50 text-success-600',
    warning: 'bg-warning-50 text-warning-600',
    error: 'bg-error-50 text-error-600',
  };

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Logo size="sm" />
          <div className="flex items-center gap-3">
            <div className="hidden sm:block text-right">
              <p className="text-sm font-semibold text-neutral-800 leading-none">{user.name}</p>
              <p className="text-xs text-neutral-500 mt-0.5">Faculty · {user.email}</p>
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
        {/* Title */}
        <div className="mb-8 flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900">Exam Management Dashboard</h1>
            <p className="text-neutral-500 mt-1">CS 401 — Data Structures & Algorithms · Fall 2026</p>
          </div>
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="h-4 w-4" />
            Create New Exam
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {stats.map((stat) => (
            <div key={stat.label} className="bg-white rounded-2xl card-shadow p-5">
              <div className={`flex items-center justify-center h-10 w-10 rounded-xl mb-3 ${colorMap[stat.color]}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              {loadingResults ? (
                <Loader2 className="h-7 w-7 text-neutral-300 animate-spin" />
              ) : (
                <p className="text-3xl font-bold text-neutral-900">{stat.value}</p>
              )}
              <p className="text-sm text-neutral-500 mt-1">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Filter + Search */}
        <div className="bg-white rounded-2xl card-shadow overflow-hidden">
          <div className="p-4 border-b border-neutral-200 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {(['all', 'completed', 'in-progress', 'flagged'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors capitalize ${
                    filter === f
                      ? 'bg-brand-600 text-white'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  }`}
                >
                  {f === 'in-progress' ? 'In Progress' : f}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search students…"
                className="pl-9 pr-4 py-2 rounded-lg border border-neutral-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent w-full sm:w-64"
              />
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
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Proctoring</th>
                  <th className="text-left text-xs font-bold text-neutral-500 uppercase tracking-wide px-4 py-3 hidden lg:table-cell">Submitted</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-neutral-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="flex items-center justify-center h-9 w-9 rounded-full text-white text-sm font-bold flex-shrink-0"
                          style={{ backgroundColor: pickColor(r.email) }}
                        >
                          {r.name.charAt(0)}
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
                      {r.status === 'in-progress' ? (
                        <span className="text-sm text-neutral-400">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-neutral-900">{r.percentage}%</span>
                          <span className="text-xs text-neutral-400">({r.score}/{r.totalMarks})</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.status === 'completed' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-success-50 text-success-700">
                          <CheckCircle2 className="h-3 w-3" />
                          Completed
                        </span>
                      )}
                      {r.status === 'in-progress' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-warning-50 text-warning-700">
                          <Clock className="h-3 w-3" />
                          In Progress
                        </span>
                      )}
                      {r.status === 'flagged' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-error-50 text-error-700">
                          <AlertTriangle className="h-3 w-3" />
                          Flagged
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {r.flags > 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-error-600">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {r.flags} flag{r.flags > 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success-600">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Clean
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <span className="text-sm text-neutral-500">{r.submittedAt || '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <button className="p-2 rounded-lg text-neutral-400 hover:text-brand-600 hover:bg-brand-50 transition-colors">
                        <Eye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && !loadingResults && (
            <div className="p-12 text-center">
              <FileText className="h-12 w-12 text-neutral-300 mx-auto mb-3" />
              <p className="text-sm text-neutral-500">No students match your search.</p>
            </div>
          )}

          {loadingResults && (
            <div className="p-12 text-center">
              <Loader2 className="h-8 w-8 text-brand-500 animate-spin mx-auto mb-3" />
              <p className="text-sm text-neutral-500">Loading student results…</p>
            </div>
          )}
        </div>

        {/* Performance overview */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-8">
          <div className="bg-white rounded-2xl card-shadow p-6">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="h-5 w-5 text-brand-600" />
              <h3 className="text-base font-bold text-neutral-900">Performance Overview</h3>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Excellent (90%+)', count: results.filter(r => r.percentage >= 90).length, color: 'bg-success-500' },
                { label: 'Good (70-89%)', count: results.filter(r => r.percentage >= 70 && r.percentage < 90).length, color: 'bg-brand-500' },
                { label: 'Average (50-69%)', count: results.filter(r => r.percentage >= 50 && r.percentage < 70).length, color: 'bg-warning-400' },
                { label: 'Below 50%', count: results.filter(r => r.percentage < 50 && r.percentage > 0).length, color: 'bg-error-500' },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-neutral-600">{row.label}</span>
                    <span className="font-bold text-neutral-900">{row.count}</span>
                  </div>
                  <div className="w-full h-2.5 bg-neutral-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${row.color} rounded-full transition-all duration-700`}
                      style={{ width: `${results.length > 0 ? (row.count / results.length) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl card-shadow p-6">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="h-5 w-5 text-brand-600" />
              <h3 className="text-base font-bold text-neutral-900">Integrity Summary</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-success-50">
                <p className="text-3xl font-bold text-success-700">
                  {results.filter(r => r.flags === 0).length}
                </p>
                <p className="text-sm text-success-600 mt-1">Clean Sessions</p>
              </div>
              <div className="p-4 rounded-xl bg-error-50">
                <p className="text-3xl font-bold text-error-700">
                  {results.filter(r => r.flags > 0).length}
                </p>
                <p className="text-sm text-error-600 mt-1">Flagged Sessions</p>
              </div>
              <div className="col-span-2 p-4 rounded-xl bg-neutral-50 border border-neutral-200">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-warning-500 flex-shrink-0" />
                  <p className="text-sm text-neutral-600 leading-relaxed">
                    {results.filter(r => r.flags > 0).length} session{results.filter(r => r.flags > 0).length !== 1 ? 's' : ''} require review due to proctoring flags. Review the session recordings before publishing final grades.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <CreateExamModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchResults();
          }}
        />
      )}
    </div>
  );
}

const palette = ['#3366f0', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#2563eb'];
function pickColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}
