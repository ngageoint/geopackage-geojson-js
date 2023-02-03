import {
  BoundingBox,
  FeatureColumn,
  FeatureIndexManager,
  FeatureIndexType,
  FeatureTableMetadata,
  GeometryColumns,
  GeoPackage,
  GeoPackageDataType,
  GeoPackageManager,
  setCanvasKitWasmLocateFile,
} from '@ngageoint/geopackage';
// @ts-ignore
import fs from 'fs';
// @ts-ignore
import path from 'path';
import bbox from '@turf/bbox';
import {GeometryType} from "@ngageoint/simple-features-js";

if (typeof window === 'undefined') {
  setCanvasKitWasmLocateFile(file => {
    // @ts-ignore
    return path.join(__dirname, file);
  });
}

export interface GeoJSONConverterOptions {
  append?: boolean;
  geoPackage?: GeoPackage | string;
  srsNumber?: number;
  tableName?: string;
  geoJson?: any;
}

export class GeoJSONToGeoPackage {
  constructor(private options?: GeoJSONConverterOptions) {}

  _calculateTrueExtentForFeatureTable(gp, tableName): Array<number> {
    let extent = undefined;
    const featureDao = gp.getFeatureDao(tableName);
    const featureIndexManager = new FeatureIndexManager(gp, featureDao);
    featureIndexManager.setContinueOnError(true);
    if (featureIndexManager.isIndexed()) {
      if (featureIndexManager.isIndexedForType(FeatureIndexType.RTREE)) {
        featureIndexManager.setIndexLocation(FeatureIndexType.RTREE);
        const boundingbox = featureIndexManager.getBoundingBox();
        extent = [boundingbox.getMinLongitude(), boundingbox.getMinLatitude(), boundingbox.getMaxLongitude(), boundingbox.getMaxLatitude()];
      } else if (featureIndexManager.isIndexedForType(FeatureIndexType.GEOPACKAGE)) {
        featureIndexManager.setIndexLocation(FeatureIndexType.GEOPACKAGE);
        const boundingbox = featureIndexManager.getBoundingBox();
        extent = [boundingbox.getMinLongitude(), boundingbox.getMinLatitude(), boundingbox.getMaxLongitude(), boundingbox.getMaxLatitude()];
      } else {
        const boundingbox = featureIndexManager.getBoundingBox();
        extent = [boundingbox.getMinLongitude(), boundingbox.getMinLatitude(), boundingbox.getMaxLongitude(), boundingbox.getMaxLatitude()];
      }
    }
    return extent;
  }

  _updateBoundingBoxForFeatureTable(gp, tableName): void {
    const contentsDao = gp.contentsDao;
    const contents = contentsDao.queryForId(tableName);
    const extent = this._calculateTrueExtentForFeatureTable(gp, tableName);
    if (extent != null) {
      contents.min_x = extent[0];
      contents.min_y = extent[1];
      contents.max_x = extent[2];
      contents.max_y = extent[3];
    } else {
      contents.min_x = -180.0;
      contents.min_y = -90.0;
      contents.max_x = 180.0;
      contents.max_y = 90.0;
    }
    contentsDao.update(contents);
  }

  async addLayer(options?: GeoJSONConverterOptions, progressCallback?: Function): Promise<any> {
    const clonedOptions = { ...this.options, ...options };
    clonedOptions.append = true;
    return this.setupConversion(clonedOptions, progressCallback);
  }

  async convert(options?: GeoJSONConverterOptions, progressCallback?: Function): Promise<GeoPackage> {
    const clonedOptions = { ...this.options, ...options };
    clonedOptions.append = false;
    return this.setupConversion(clonedOptions, progressCallback);
  }

  async extract(geopackage: GeoPackage, tableName: string): Promise<any> {
    const geoJson = {
      type: 'FeatureCollection',
      features: [],
    };
    const resultSet = geopackage.queryForGeoJSONFeatures(tableName);
    for (const feature of resultSet) {
      geoJson.features.push(feature);
    }
    resultSet.close();
    return Promise.resolve(geoJson);
  }

  async setupConversion(options: GeoJSONConverterOptions, progressCallback?: Function): Promise<GeoPackage> {
    let geoPackage = options.geoPackage;
    const srsNumber = options.srsNumber || 4326;
    let geoJson: any = options.geoJson;
    let tableName = options.tableName;
    geoPackage = await this.createOrOpenGeoPackage(geoPackage, options, progressCallback);
    // figure out the table name to put the data into
    let name;
    if (typeof geoJson === 'string') {
      name = path.basename(geoJson, path.extname(geoJson));
    }
    name = tableName || name || 'features';
    let nameSuffix = '';
    const tables = geoPackage.getFeatureTables();
    let count = 1;
    while (tables.indexOf(name + nameSuffix) !== -1) {
      nameSuffix = '_' + count;
      count++;
    }
    tableName = name + nameSuffix;
    if (typeof geoJson === 'string') {
      if (progressCallback) await progressCallback({ status: 'Reading GeoJSON file' });
      geoJson = await new Promise(function(resolve, reject) {
        fs.readFile(geoJson, 'utf8', function(err, data) {
          resolve(JSON.parse(data));
        });
      });
    }

    const featureCollection = {
      type: 'FeatureCollection',
      features: [],
    };

    const properties = {};
    for (let i = 0; i < geoJson.features.length; i++) {
      const feature = geoJson.features[i];
      this.addFeatureProperties(feature, properties);
      if (feature.geometry !== null) {
        featureCollection.features.push(feature);
      } else {
        featureCollection.features.push({
          type: 'Feature',
          properties: feature.properties,
          geometry: null,
        });
      }
    }

    return this.convertGeoJSONToGeoPackage(
      featureCollection,
      geoPackage,
      tableName,
      properties,
      srsNumber,
      progressCallback,
    );
  }

  /**
   * Determine the columns to add
   * @param feature
   * @param currentProperties
   */
  addFeatureProperties(feature: any, currentProperties: Record<string, any>): void {
    if (feature.properties.geometry) {
      feature.properties.geometry_property = feature.properties.geometry;
      delete feature.properties.geometry;
    }

    if (feature.id) {
      if (currentProperties['_feature_id'] == null) {
        currentProperties['_feature_id'] = {
          name: '_feature_id',
          type: 'TEXT',
          conversion: value => value.toString()
        };
      }
    }

    for (const key in feature.properties) {
      if (!currentProperties[key]) {
        let type: string = typeof feature.properties[key];
        let conversion = null;
        if (feature.properties[key] !== undefined && feature.properties[key] !== null && type !== 'undefined') {
          if (type === 'object') {
            if (feature.properties[key] instanceof Date) {
              type = 'Date';
            } else {
              type = 'TEXT';
              conversion = value => JSON.stringify(value);
            }
          }
          switch (type) {
            case 'Date':
              type = 'DATETIME';
              break;
            case 'number':
              type = 'DOUBLE';
              break;
            case 'string':
              type = 'TEXT';
              break;
            case 'boolean':
              type = 'BOOLEAN';
              break;
          }
          currentProperties[key] = {
            name: key,
            type: type,
            conversion: conversion
          };
        }
      }

      if (feature.properties[key] == null) {
        delete feature.properties[key];
      }

      if (currentProperties[key] != null && currentProperties[key].conversion != null) {
        feature.properties[key] = currentProperties[key].conversion(feature.properties[key]);
      }
    }
  }

  async convertGeoJSONToGeoPackage(
    geoJson: any,
    geoPackage: GeoPackage,
    tableName: string,
    properties: Record<string, any>,
    srsNumber: number,
    progressCallback?: Function,
  ): Promise<GeoPackage> {
    return this.convertGeoJSONToGeoPackageWithSrs(
      geoJson,
      geoPackage,
      tableName,
      properties,
      srsNumber,
      progressCallback,
    );
  }

  async convertGeoJSONToGeoPackageWithSrs(
    geoJson: any,
    geoPackage: GeoPackage,
    tableName: string,
    properties: Record<string, any>,
    srsNumber: number,
    progressCallback?: Function,
  ): Promise<GeoPackage> {
    const geometryColumns = new GeometryColumns();
    geometryColumns.setTableName(tableName);
    geometryColumns.setColumnName('geometry');
    geometryColumns.setGeometryType(GeometryType.GEOMETRY);
    geometryColumns.setZ(2);
    geometryColumns.setM(2);
    geometryColumns.setSrsId(4326);

    const columns: FeatureColumn[] = [];
    let index = 2;

    for (const key in properties) {
      const prop = properties[key];
      if (prop.name.toLowerCase() !== 'id') {
        columns.push(FeatureColumn.createColumn(prop.name, GeoPackageDataType.fromName(prop.type)));
      } else {
        columns.push(
          FeatureColumn.createColumn(
            '_properties_' + prop.name,
            GeoPackageDataType.fromName(prop.type),
            false,
            null,
          ),
        );
      }
      index++;
    }

    if (progressCallback) await progressCallback({ status: 'Creating table "' + tableName + '"' });
    const tmp = bbox(geoJson);
    const boundingBox: BoundingBox = new BoundingBox(
      Math.max(-180, tmp[0]),
      Math.min(180, tmp[2]),
      Math.max(-90, tmp[1]),
      Math.min(90, tmp[3]),
    );
    if (
      geoPackage
        .getFeatureTables()
        .map(table => table.toLowerCase())
        .indexOf(tableName.toLowerCase()) === -1
    ) {
      geoPackage.createFeatureTableWithMetadata(FeatureTableMetadata.create(geometryColumns, columns, 'id', boundingBox));
    }
    const featureDao = geoPackage.getFeatureDao(tableName);
    const srs = featureDao.getSrs();
    let count = 0;
    const featureCount = geoJson.features.length;
    const fivePercent = Math.floor(featureCount / 20);
    for (let i = 0; i < featureCount; i++) {
      const feature = geoJson.features[i];
      if (feature.id) {
        feature.properties._feature_id = feature.id.toString();
      }

      if (feature.properties.id) {
        feature.properties._properties_id = feature.properties.id;
        delete feature.properties.id;
      }
      if (feature.properties.ID) {
        feature.properties._properties_ID = feature.properties['ID'];
        delete feature.properties['ID'];
      }
      geoPackage.addGeoJSONFeatureToGeoPackageWithFeatureDaoAndSrs(feature, featureDao, srs, FeatureIndexType.RTREE);
      if (count++ % fivePercent === 0) {
        if (progressCallback)
          await progressCallback({
            status: 'Inserting features into table "' + tableName + '"',
            completed: count,
            total: featureCount,
          });
      }
    }
    if (progressCallback) {
      await progressCallback({
        status: 'Done inserting features into table "' + tableName + '"',
      });
    }

    this._updateBoundingBoxForFeatureTable(geoPackage, tableName);
    return geoPackage;
  }

  async createOrOpenGeoPackage(
    geoPackage: GeoPackage | string,
    options: GeoJSONConverterOptions,
    progressCallback?: Function,
  ): Promise<GeoPackage> {
    if (typeof geoPackage === 'object') {
      if (progressCallback) await progressCallback({ status: 'Opening GeoPackage' });
      return geoPackage;
    } else {
      let stats;
      try {
        stats = fs.statSync(geoPackage);
      } catch (e) {}
      if (stats && !options.append) {
        throw new Error('GeoPackage file already exists, refusing to overwrite ' + geoPackage);
      } else if (stats) {
        return GeoPackageManager.open(geoPackage);
      }
      if (progressCallback) await progressCallback({ status: 'Creating GeoPackage' });
      return GeoPackageManager.create(geoPackage);
    }
  }
}