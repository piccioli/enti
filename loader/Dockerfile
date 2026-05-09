FROM postgis/postgis:16-3.4

RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin \
    curl \
    unzip \
    zip \
    jq \
    python3 \
    python3-openpyxl \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /loader
COPY load.sh load_popolazione.sh load_altimetria.sh load_comuni_montani_l131.sh load_contatti_comuni.sh \
    build_contatti_comuni_from_ipa.sh build_contatti_comuni_from_ipa.py \
    parse_altimetria_xlsx.py parse_comuni_montani_pdf_xml.py post_load.sql \
    export_datapack.sh import_datapack.sh ./
RUN chmod +x load.sh load_popolazione.sh load_altimetria.sh load_comuni_montani_l131.sh load_contatti_comuni.sh build_contatti_comuni_from_ipa.sh \
    export_datapack.sh import_datapack.sh

CMD ["bash", "load.sh"]
