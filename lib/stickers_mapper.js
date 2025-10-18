const ID_DICT_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json"

class StickersMapper {
  constructor() {
    this.id_dict_url = ID_DICT_URL;
    this._mapped_stickers = {};
  }

  async load() {
    const res = await fetch(this.id_dict_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    json.forEach(sticker_data => {
        this._mapped_stickers[sticker_data["def_index"]] = sticker_data["name"];
    });
  }

  stickerName(def_index) {
     return this._mapped_stickers[String(def_index)] ?? null;
  }
}

module.exports = new StickersMapper();
