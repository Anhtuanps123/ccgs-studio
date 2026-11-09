export function Placeholder({ title, phase }: { title: string; phase: number }) {
  return (
    <>
      <div className="view-head"><div><h1>{title}</h1></div></div>
      <div className="panel"><div className="empty">Màn hình này được làm ở Phase {phase}. Chưa có dữ liệu thật để hiển thị.</div></div>
    </>
  );
}
