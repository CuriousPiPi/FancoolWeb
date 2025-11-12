构建 R→LAeq 标定（仅 A 加权）并输出：
- calib.json：R→LAeq（去环境）PCHIP 模型、各 RPM 锚点 1/12 频带谱（扣环境后）
- calibration_report.csv：总体报告（env 与各挡位在“处理后口径”的 LAeq 与 AWA 的对比）

处理与参数要点（本版采用“逐带聚合前 MAD 可独立开关”的更清晰命名与逻辑）：
1) 仅 A 加权；默认 perfile 标定
   - 对 env/ 与各 RPM 目录内的每个音频，先用“整段无裁剪/无高通”口径与各自 .AWA 的 LAeq 标定得到 sA_use（Pa/FS）
   - env/ 的会话基准刻度 sA_env 由 env/.AWA LAeq 与整段口径得到

2) 处理阶段（用于稳健聚合与锚点谱）
   - 默认裁剪：首/尾各 0.5 s（可参数配置）
   - 默认高通：20 Hz（可参数配置；<=0 关闭）
   - 分帧 Welch，求 A 加权 1/12 带能量时序 E_A[k, t] 与每帧总能量 Etot(t)

3) 双通道聚合（env 与 meas），“100 表示关闭逐带分位改为均值”
   - 先按 Etot 选“底部 Qf%”帧作为候选（--env-agg-per-frame, --meas-agg-per-frame；默认 env=40、meas=40；设 100 表示不过滤）
   - 然后“逐带聚合前 MAD（双侧）”——可独立开关（与是否启用逐帧/逐带分位无关）
     · 控制开关：--env-mad-pre-band on|off（默认 on）、--meas-mad-pre-band on|off（默认 on）
     · 强度：--mad-tau（默认 3.0）
   - 最后逐带聚合：
     · 若 Qb% < 100（--env-agg-per-band, --meas-agg-per-band），按该分位取值（默认 env=20、meas=100→关闭逐带分位）
     · 若 Qb%=100：改为逐带均值（仍在 MAD 之后）

4) 环境基线带向平滑
   - --env-smooth-bands（默认 0）：0 不平滑；1 表示 3 点中值（左右各 1 带）带向平滑

5) 能量域扣环境与无效标记
   - 判定：若 E_meas_band ≤ (--snr-ratio-min × E_env_band) 则该带记为无效（None），不写 0 dB（避免与负值混淆）
   - LAeq 合成时，None 按 0 能量处理；扣除能量用于合成为 max(E_meas - E_env, 0)

6) 报告（calibration_report.csv）
   - 记录 env 与每个挡位（以及每个文件）的“处理后口径”的 LAeq（raw 与 post_env）与 .AWA LAeq 的差值
   - 便于根据参数快速对齐口径并观察 None 的影响

默认参数：
- 标定：--calib-mode=perfile
- env：--env-agg-per-frame=40，--env-agg-per-band=20，--env-mad-pre-band=on，--env-smooth-bands=0
- meas：--meas-agg-per-frame=40，--meas-agg-per-band=100，--meas-mad-pre-band=on
- MAD：--mad-tau=3.0
- below_env：--snr-ratio-min=1.0
- 处理阶段裁剪与高通：--trim-head-sec=0.5，--trim-tail-sec=0.5，--highpass-hz=20

依赖：numpy, soundfile, scipy

整合版：内存流水线（不写中间文件）
- 输入：root_dir（包含 env/ 与各 Rxxxx 目录），params 字典
- 输出：
  - preview_model_json（前端频谱预览所需模型）
  - per_rpm_rows（每档聚合输出，含 env=0 行）
可选：传 out_dir 时，会把 calib.json 和 calibration_report.csv 顺手写出（便于排查）