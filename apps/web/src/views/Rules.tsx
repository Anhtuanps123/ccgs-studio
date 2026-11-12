// "Quy tắc": the 9 rules for using CCGS, what Studio enforces for each, and what it sees in the project now (api-contract §12).
import { Link } from 'react-router-dom';
import type { ProjectRuleState } from '@ccgs/shared';
import { useApi } from '../api';

interface Rule { n: number; title: string; why: string; ex: string; does: string[]; you: string[] }

/** Same rules as the shared guide; "ex" = a short concrete case, "does" = what Studio enforces, "you" = what stays with the user. */
export const RULES: Rule[] = [
  { n: 1, title: 'Cấu hình đúng trước khi làm', why: 'Rigor quyết định game cần bao nhiêu tài liệu, test và review.',
    ex: 'Game có 3 tính năng (Piggy Bank, Lucky Spin, Shop) mà vẫn để minimal, nên không có bước review nào bắt lỗi thiết kế. Nên nâng lên standard.',
    does: ['Chặn lập kế hoạch nếu chưa chạy /start.', 'Cảnh báo khi đang minimal mà có từ 3 epic hoặc 3 GDD.'],
    you: ['Game lớn hơn 1 trang brief thì đổi sang standard (/settings).', 'Ở minimal, stage luôn là Concept: bình thường.'] },
  { n: 2, title: 'Đi đúng thứ tự, không nhảy cóc', why: 'Bước trước tạo đầu vào cho bước sau.',
    ex: 'Bỏ /design-review của GDD Lucky Spin thì bảng thưởng sai đi thẳng vào code, sửa sau tốn gấp nhiều lần.',
    does: ['Kế hoạch thiếu bước hoặc sai thứ tự thì không cho Duyệt.', 'Standard/full: tự thêm /story-readiness trước /dev-story, /ux-review sau /ux-design.', 'Sau mỗi bước đọc kết quả để chạy tiếp, sửa 1 lần hoặc dừng.'],
    you: ['Chơi thử prototype rồi chốt PROCEED / PIVOT / KILL.'] },
  { n: 3, title: 'Không code khi còn câu hỏi mở', why: 'Story bỏ trống chỗ nào thì code thiếu đúng chỗ đó.',
    ex: 'Story Piggy Bank chưa chốt "đầy 200 điểm thì nút làm gì", nên /dev-story sẽ tự đoán. Studio dừng lại để hỏi bạn trước.',
    does: ['Đọc story và GDD trước mỗi /dev-story; còn câu hỏi thì dừng và liệt kê.', 'Bấm Tiếp tục là chấp nhận code theo hiện trạng.'],
    you: ['Acceptance criteria đo được, có trạng thái biên (0, đầy, hết lượt, đổi ngày).'] },
  { n: 4, title: 'Đổi thiết kế thì sửa story trước', why: 'Story viết theo thiết kế cũ thì code cũng theo luật cũ.',
    ex: 'GDD Piggy Bank đổi từ 1 lên 2 lần nhận mỗi ngày, nhưng story 001–004 vẫn ghi 1 lần, nên code sẽ làm 1 lần.',
    does: ['Thiết kế lại tính năng đã có story: tự chèn bước cập nhật story (và /propagate-design-change nếu có).'],
    you: ['Duyệt từng story được đề xuất sửa.'] },
  { n: 5, title: 'Đúng skill cho đúng việc', why: 'Skill review và QA chỉ báo cáo, không sửa gì.',
    ex: 'Gọi /team-qa để "sửa nút Claim không bấm được" thì chỉ nhận về một báo cáo; nút vẫn lỗi.',
    does: ['Kế hoạch sửa lỗi mà không có bước sửa thật thì báo lỗi hoặc cảnh báo.'],
    you: ['Chỉ dùng /team-qa để chốt chất lượng cuối sprint.'] },
  { n: 6, title: 'Subagent không thấy những gì bạn thấy', why: 'Subagent chỉ đọc brief, thường không có Unity MCP và không nhìn màn hình.',
    ex: 'Bạn dán ảnh lỗi popup vào chat, nhưng subagent sửa UI không nhận được ảnh đó và sửa sai chỗ.',
    does: ['Dặn mọi task: việc cần nhìn hoặc thao tác Unity thì làm ở session chính.', 'Tệp đính kèm được đưa cho mọi bước.'],
    you: ['Ghi ảnh và thông tin quan trọng vào file (story, bug report), đừng chỉ nói trong chat.'] },
  { n: 7, title: 'Viết quy ước UI ra file', why: 'Không có quy ước thì mỗi agent làm UI một kiểu.',
    ex: 'Popup mới dùng font, nút và khoảng cách khác hẳn các popup cũ vì agent không biết mẫu nào là chuẩn.',
    does: ['Kế hoạch có UI mà chưa có design/conventions.md: tự chèn /studio:project-conventions.', 'Dặn mọi task dựng UI mới theo màn mẫu trong file đó.'],
    you: ['Chạy lại /studio:project-conventions khi đổi phong cách UI.'] },
  { n: 8, title: 'Ảnh bằng chứng phải được so sánh', why: 'Có ảnh chỉ chứng tỏ đã chụp, không chứng tỏ là đúng.',
    ex: 'Story có ảnh popup Piggy Bank, nhưng đặt cạnh màn mẫu mới thấy thiếu nút đóng.',
    does: ['Story UI: tự thêm /studio:ui-compare trước /story-done; sửa lỗi UI thì thêm sau bước sửa.', 'Kết quả FAIL hoặc CONCERNS thì dừng.'],
    you: ['Xem compare.md và ảnh trong production/qa/evidence/.'] },
  { n: 9, title: 'Ghi checkpoint, làm từng việc một', why: 'active.md là bộ nhớ của dự án; hội thoại thì không.',
    ex: 'Story 003 còn In Progress mà đã nhận story 004; mở session mới thì không ai nhớ 003 đang dở ở đâu.',
    does: ['Đưa mục đang treo trong active.md vào kế hoạch và form Yêu cầu mới.'],
    you: ['Xử lý mục "Open" và "chưa review" trước khi nhận việc mới.', 'Mỗi lúc chỉ một story In Progress.'] },
];

const CHECKLISTS: [string, string[]][] = [
  ['Trước khi chạy /dev-story', ['Rigor hợp với quy mô hiện tại', 'GDD/UX đã review, hoặc ghi lý do bỏ qua', 'Không còn câu hỏi mở', 'Story khớp bản thiết kế mới nhất', 'Story ghi "Dựa trên: <màn mẫu>"', 'Acceptance criteria đo được, có trạng thái biên']],
  ['Trước khi chạy /story-done', ['Đã chạy thật trong engine, không chỉ compile', 'Ảnh đặt cạnh màn mẫu, đủ trạng thái', 'Test logic chạy thật và pass', 'Console không có lỗi mới', 'Cập nhật active.md']],
  ['Trước khi chạy /team-qa', ['Mọi story trong phạm vi đã Done', 'Đã chạy /smoke-check', 'Bug S1/S2 đã đóng hoặc đã quyết', 'Sẵn sàng tự test ở bước Manual QA']],
];

function ProjectState() {
  const st = useApi<ProjectRuleState>('/api/pipelines/project-state');
  const s = st.data;
  const big = s && s.rigor === 'minimal' && (s.epics >= 3 || s.gdds >= 3);
  return (
    <div className="panel"><div className="panel-h"><h3>Project hiện tại</h3><button className="btn sm" onClick={() => st.reload()}>Kiểm tra lại</button></div>
      <div className="panel-b stack" style={{ gap: 6 }}>
        {!s ? <div className="muted small">{st.error ?? 'Đang đọc…'}</div> : <>
          <ul className="checks">
            <li><span className={`mark ${big ? 'warn' : 'ok'}`}>{big ? '!' : '✓'}</span><div className="small">Rigor <b>{s.rigor ?? 'Unknown'}</b> · {s.epics} epic · {s.gdds} GDD{big ? '. Cân nhắc standard.' : ''}</div></li>
            <li><span className={`mark ${s.conventions.exists ? 'ok' : 'warn'}`}>{s.conventions.exists ? '✓' : '!'}</span><div className="small">
              {s.conventions.exists ? <>Có <code>{s.conventions.path}</code>.</> : <>Chưa có <code>{s.conventions.path}</code>. <Link to="/tasks?skill=studio:project-conventions">Chạy /studio:project-conventions</Link> (cần Unity Editor đang mở).</>}</div></li>
            <li><span className={`mark ${s.openItems.length ? 'warn' : 'ok'}`}>{s.openItems.length ? '!' : '✓'}</span><div className="small">
              {s.openSource ? (s.openItems.length ? <><code>{s.openSource}</code> còn {s.openItems.length} mục đang treo:</> : 'active.md không có mục đang treo.') : 'Không có production/session-state/active.md.'}</div></li>
          </ul>
          {s.openItems.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 22 }}>{s.openItems.map((i, k) => <li key={k}><span className="tag">{i.kind === 'checkpoint' ? 'checkpoint' : i.kind === 'open' ? 'open' : 'chưa review'}</span> {i.text}</li>)}</ul>}
        </>}
      </div></div>
  );
}

export function Rules() {
  return (
    <>
      <div className="view-head"><div><h1>Quy tắc dùng CCGS</h1><p>9 quy tắc chung cho mọi dự án. Mỗi quy tắc ghi phần Studio tự áp dụng khi lập kế hoạch và chạy, và phần bạn vẫn phải tự làm.</p></div></div>
      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)' }}>
        <div className="stack">
          {RULES.map(r => (
            <div key={r.n} className="panel" id={`rule-${r.n}`}><div className="panel-h"><h3>{r.n}. {r.title}</h3></div>
              <div className="panel-b stack" style={{ gap: 6 }}>
                <div className="small muted">{r.why}</div>
                <div className="small" style={{ background: 'var(--accent-soft)', borderRadius: 6, padding: '6px 10px' }}><b>Ví dụ:</b> {r.ex}</div>
                <div className="small"><b>Studio tự làm</b><ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>{r.does.map((d, k) => <li key={k}>{d}</li>)}</ul></div>
                <div className="small"><b>Bạn làm</b><ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>{r.you.map((d, k) => <li key={k}>{d}</li>)}</ul></div>
              </div></div>
          ))}
        </div>
        <div className="stack">
          <ProjectState />
          {CHECKLISTS.map(([t, xs]) => (
            <div key={t} className="panel"><div className="panel-h"><h3>{t}</h3></div>
              <div className="panel-b"><ul className="checks">{xs.map(x => <li key={x}><span className="mark pend" aria-hidden="true"></span><div className="small">{x}</div></li>)}</ul></div></div>
          ))}
        </div>
      </div>
    </>
  );
}
