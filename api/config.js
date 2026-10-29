// 브라우저용 Supabase 공개 설정(URL, anon key)을 환경변수에서 읽어 내려준다.
// anon key 는 공개용 키이며, 데이터 보호는 Supabase 의 RLS 정책이 담당한다.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  });
};
