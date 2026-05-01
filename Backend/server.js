require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js'); 

// --- NGUYÊN LIỆU MỚI: TELEGRAM BOT ---
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron'); // Gọi người nhắc việc
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const chatId = process.env.TELEGRAM_CHAT_ID;
// ------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.get('/api/projects', async (req, res) => {
    try {
        const { data, error } = await supabase.from('projects').select('*');
        if (error) throw error;
        res.json({ success: true, total: data.length, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: "Lỗi Server" });
    }
});

// --- API MỚI: RA LỆNH CHO BOT NHẮN TIN ---
app.get('/api/test-bot', async (req, res) => {
    try {
        const loiChao = "🤖 Báo cáo sếp Minh: Trợ lý Bot đã kết nối thành công với Backend Node.js!";
        await bot.sendMessage(chatId, loiChao);
        res.json({ success: true, message: "Đã bắn tin nhắn qua Telegram!" });
    } catch (error) {
        console.error("Lỗi gửi bot:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// --- TỰ ĐỘNG HÓA: BÁO CÁO THỰC CHIẾN (17H00 TỪ THỨ 2 -> THỨ 7) ---
cron.schedule('0 17 * * 1-6', async () => {
    console.log('⏳ Đang soi tiến độ chi tiết từng dự án (17h00)...');
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = today.toISOString();

        // Danh sách người phụ trách tương ứng với 9 giai đoạn
        const STAGE_NAMES = ['Dự toán', 'Đặt VT', 'NCC Giao', 'TK Khung', 'TK Panel', 'Sản xuất', 'Tài liệu', 'Kiểm tra', 'Nghiệm thu'];
        const STAGE_OWNERS = ['Trí', 'Phòng Mua Hàng', 'Ms. Quỳnh', 'Tùng', 'Tiến', 'Team SX', 'Tiến', 'Tiến/Tùng', 'Minh/Trình'];

        const { data: projects } = await supabase.from('projects').select('*');
        if (!projects || projects.length === 0) return;

        for (const proj of projects) {
            const { data: equips } = await supabase.from('equipments').select('*').eq('project_id', proj.id);
            const { data: blockers } = await supabase.from('blockers').select('*').eq('project_id', proj.id);
            const { data: todayLogs } = await supabase.from('activity_logs')
                .select('message, actor, created_at')
                .eq('project_id', proj.id).gte('created_at', todayIso).order('created_at', { ascending: false });

            let activeEquips = 0; let sumPct = 0;
            let redAlerts = []; // Danh sách trễ hạn
            let hotZones = [];  // Danh sách sắp đến hạn (<= 3 ngày)

            if (equips) {
                equips.forEach(e => {
                    if (e.status === 'Đã xóa' || e.status === 'Tạm dừng') return;
                    activeEquips++;
                    sumPct += parseFloat(e.total_pct || 0);

                    if (e.status === 'Hoàn thành') return; 

                    if (Array.isArray(e.stages)) {
                        e.stages.forEach((st, idx) => {
                            if (st.pct >= 100 || st.confirmed || !st.deadline) return; 

                            const dlDate = new Date(st.deadline);
                            dlDate.setHours(0, 0, 0, 0);
                            const daysDiff = Math.round((dlDate - today) / (1000 * 60 * 60 * 24));

                            if (daysDiff < 0) {
                                redAlerts.push(`   🔺 #${e.id} ${e.name.substring(0,20)}: [${STAGE_NAMES[idx]}] trễ ${Math.abs(daysDiff)} ngày ➜ Gọi: *${STAGE_OWNERS[idx]}*`);
                            } else if (daysDiff >= 0 && daysDiff <= 3) {
                                hotZones.push(`   ⚠️ #${e.id} ${e.name.substring(0,20)}: [${STAGE_NAMES[idx]}] còn ${daysDiff} ngày ➜ Nhắc: *${STAGE_OWNERS[idx]}*`);
                            }
                        });
                    }
                });
            }

            const avgProgress = activeEquips > 0 ? (sumPct / activeEquips).toFixed(1) : 0;
            const openBlockers = blockers ? blockers.filter(b => b.status !== 'Đã giải quyết').length : 0;

            // Lọc log làm việc trong ngày
            let logText = (!todayLogs || todayLogs.length === 0) ? '💤 _Không có cập nhật nào hôm nay._' : '';
            if (todayLogs && todayLogs.length > 0) {
                todayLogs.slice(0, 10).forEach(log => {
                    const timeStr = new Date(log.created_at).toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'});
                    logText += `\n▫️ \`[${timeStr}]\` *${log.actor}*: ${log.message}`;
                });
                if (todayLogs.length > 10) logText += `\n_...và ${todayLogs.length - 10} thao tác khác._`;
            }

            // Xây dựng cảnh báo Deadline
            let alertText = '';
            if (redAlerts.length > 0) {
                alertText += `\n🔥 *BÁO ĐỘNG ĐỎ (ĐÃ TRỄ HẠN):*\n${redAlerts.slice(0, 7).join('\n')}`;
                if (redAlerts.length > 7) alertText += `\n   _...và ${redAlerts.length - 7} mục trễ hạn khác._`;
            }
            if (hotZones.length > 0) {
                alertText += `\n\n⚡ *VÙNG NÓNG (DEADLINE <= 3 NGÀY):*\n${hotZones.slice(0, 7).join('\n')}`;
                if (hotZones.length > 7) alertText += `\n   _...và ${hotZones.length - 7} mục sắp hạn khác._`;
            }
            if (!alertText) alertText = `\n✅ *TUYỆT VỜI:* Không có thiết bị nào trễ hạn hoặc sắp tới deadline!`;

            // Ráp thành Báo cáo hoàn chỉnh
            const reportMsg = `
📁 *DỰ ÁN: ${proj.name.toUpperCase()}*
━━━━━━━━━━━━━━━━━━
📊 *TIẾN ĐỘ TỔNG THỂ:*
- Hoàn thành: *${avgProgress}%* (trên ${activeEquips} hạng mục)
- Điểm nghẽn đang mở: ${openBlockers > 0 ? `🚨 *${openBlockers} vấn đề*` : '✅ 0'}
${alertText}

📝 *HOẠT ĐỘNG TRONG NGÀY HÔM NAY:*${logText}
            `;

            // Bắn vào Group Telegram
            await bot.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
        }
        
        console.log('✅ Đã bắn xong báo cáo 17h00!');

    } catch (error) {
        console.error('❌ Lỗi khi làm báo cáo tự động:', error.message);
    }
});
// ------------------------------------------
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});