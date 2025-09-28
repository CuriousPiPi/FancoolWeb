import os, sys
# 确保项目根目录在 sys.path（若你始终在根目录运行，可省略这几行）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from app import create_app

app = create_app()

if __name__ == '__main__':
    app.logger.setLevel('INFO')
    app.run(host='0.0.0.0', port=5001, debug=app.config.get('DEBUG', False), use_reloader=False)