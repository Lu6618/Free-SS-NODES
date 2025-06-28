from flask import Flask, request, jsonify
import requests
import re
import json
import html

app = Flask(__name__)

@app.route("/parse")
def parse():
    key = request.args.get("key")
    share_url = request.args.get("url")
    if key != "DYYY" or not share_url:
        return jsonify({"code": 400, "msg": "参数错误"})

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)",
        }

        resp = requests.get(share_url, headers=headers, allow_redirects=True)
        video_url = resp.url

        match = re.search(r"video/(\d+)", video_url)
        if not match:
            return jsonify({"code": 404, "msg": "无法提取视频ID"})

        video_id = match.group(1)

        page_resp = requests.get(video_url, headers=headers)
        html_content = page_resp.text

        data_match = re.search(r'<script id="RENDER_DATA" type="application/json">(.+?)</script>', html_content)
        if not data_match:
            return jsonify({"code": 500, "msg": "无法提取页面数据"})

        raw_json = html.unescape(data_match.group(1))
        data = json.loads(raw_json)

        item_module = data.get("app", {}).get("page", {}).get("video", {}).get("videoData", {}).get("itemInfo", {}).get("itemStruct", {})

        if not item_module:
            return jsonify({"code": 500, "msg": "未找到视频信息"})

        result = {
            "code": 200,
            "msg": "解析成功",
            "video_id": video_id,
            "desc": item_module.get("desc"),
            "author": item_module.get("author", {}).get("nickname"),
            "cover": item_module.get("video", {}).get("cover"),
            "no_watermark_url": item_module.get("video", {}).get("playAddr"),
            "duration": item_module.get("video", {}).get("duration"),
            "stats": {
                "like_count": item_module.get("stats", {}).get("diggCount"),
                "comment_count": item_module.get("stats", {}).get("commentCount"),
                "share_count": item_module.get("stats", {}).get("shareCount"),
                "play_count": item_module.get("stats", {}).get("playCount"),
            }
        }

        return jsonify(result)

    except Exception as e:
        return jsonify({"code": 500, "msg": str(e)})
